//! Connection manager.
//!
//! Threads per connection:
//! * **reader** – reads bytes, splits lines, classifies them, tracks status and
//!   controller info, routes acknowledgements into the streaming [`Engine`],
//!   and handles auto-reconnect.
//! * **worker** – pumps the engine (writes lines as buffer space allows), polls
//!   status, drives the job stop sequence and emits progress events.
//!
//! Real-time bytes bypass the engine and are written immediately.
//!
//! Safety rules enforced here (see AGENTS.md):
//! * Bytes sent without a click: `?` status polls, and after the controller's
//!   welcome banner the read-only queries `$I`, `$$`, `$G`, `$#`.
//! * Reset, alarm, welcome banner (controller reset) or connection loss flushes
//!   everything queued and aborts a running job. Nothing is re-sent after a
//!   reconnect.
//! * Interactive commands are refused while a job runs (read-only queries are
//!   allowed while it is paused). Jogging is refused during jobs and when the
//!   machine is not idle.
//! * Stopping a job: feed hold now, soft reset once the machine reports
//!   Hold:0/Idle/Alarm or after `STOP_RESET_TIMEOUT` at the latest.

use crate::sender::{AckEvent, Engine, Job, JobMode, JobPhase, JobProgress, Origin, Outgoing};
use grbl_core::firmware::{parse_legacy_build, parse_welcome, BuildInfo, FirmwareInfo};
use grbl_core::gcode_prep::PreparedLine;
use grbl_core::protocol::{parse_line, GrblLine};
use grbl_core::realtime;
use grbl_core::status::{MachineState, MachineStatus, StatusTracker};
use grbl_core::transport::{ByteReader, ByteWriter, TransportFactory};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const STOP_RESET_TIMEOUT: Duration = Duration::from_millis(800);
const IDENTIFY_COMMANDS: [&str; 4] = ["$I", "$$", "$G", "$#"];
/// Commands allowed while a job is paused (they change nothing).
const READ_ONLY: [&str; 5] = ["$$", "$#", "$G", "$I", "$N"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum LinkState {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    /// Transport failed; auto-reconnect may follow.
    Lost,
    Reconnecting,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub position: Vec<f64>,
    pub success: bool,
}

/// What we know about the controller from `$$`, `$#`, `$G`, `$I`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerInfo {
    pub settings: BTreeMap<u16, String>,
    pub offsets: BTreeMap<String, Vec<f64>>,
    pub parser_state: Vec<String>,
    pub build: BuildInfo,
    pub probe: Option<ProbeResult>,
    pub rx_buffer: usize,
    pub char_counting: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LinkEvent {
    State { state: LinkState, description: Option<String>, message: Option<String> },
    Rx { line: String, parsed: GrblLine, ts: u64 },
    Tx { line: String, realtime: bool, ts: u64 },
    Status { status: MachineStatus, ts: u64 },
    Firmware { info: FirmwareInfo },
    Queue { pending: usize, in_flight: bool, dropped: usize },
    Controller { info: ControllerInfo },
    Job { progress: JobProgress },
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: LinkEvent);
}

#[derive(Debug, Clone)]
pub struct LinkOptions {
    pub poll_hz: f64,
    pub auto_reconnect: bool,
    pub reconnect_attempts: u32,
    pub reconnect_interval: Duration,
    /// If no welcome banner arrives within this time, identify anyway.
    pub identify_after: Duration,
    pub max_queue: usize,
    pub max_line_len: usize,
    /// Character counting (true) or send-response (false)
    pub char_counting: bool,
    /// Controller RX buffer size until `$I` reports the real one
    pub rx_buffer: usize,
}

impl Default for LinkOptions {
    fn default() -> Self {
        LinkOptions {
            poll_hz: 8.0,
            auto_reconnect: true,
            reconnect_attempts: 15,
            reconnect_interval: Duration::from_secs(2),
            identify_after: Duration::from_millis(2500),
            max_queue: 200,
            max_line_len: 255,
            char_counting: true,
            rx_buffer: 128,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum LinkError {
    #[error("already connected — disconnect first")]
    AlreadyConnected,
    #[error("not connected")]
    NotConnected,
    #[error("could not open the port: {0}")]
    Open(String),
    #[error("{0}")]
    InvalidLine(String),
    #[error("command queue is full ({0} lines)")]
    QueueFull(usize),
    #[error("write failed: {0}")]
    Io(String),
    #[error("{0}")]
    Busy(String),
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkSnapshot {
    pub state: LinkState,
    pub description: Option<String>,
    pub firmware: Option<FirmwareInfo>,
    pub status: Option<MachineStatus>,
    pub controller: ControllerInfo,
    pub job: Option<JobProgress>,
}

struct Shared {
    writer: Mutex<Option<Box<dyn ByteWriter>>>,
    stop: AtomicBool,
    firmware_seen: AtomicBool,
    identified: AtomicBool,
    engine: Mutex<Engine>,
    snapshot: Arc<Mutex<LinkSnapshot>>,
    sink: Arc<dyn EventSink>,
    kick: Mutex<mpsc::Sender<()>>,
    controller_dirty: AtomicBool,
}

impl Shared {
    fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut w = self.writer.lock().expect("writer lock");
        match w.as_mut() {
            Some(w) => w.write_all(bytes),
            None => Err(io::Error::new(io::ErrorKind::NotConnected, "not connected")),
        }
    }

    fn engine(&self) -> MutexGuard<'_, Engine> {
        self.engine.lock().expect("engine lock")
    }

    fn kick(&self) {
        let _ = self.kick.lock().expect("kick lock").send(());
    }

    fn set_state(&self, state: LinkState, description: Option<String>, message: Option<String>) {
        set_state(&self.snapshot, self.sink.as_ref(), state, description, message);
    }

    fn realtime(&self, byte: u8) {
        if self.write(&[byte]).is_ok() && byte != realtime::STATUS_REPORT {
            self.sink.emit(LinkEvent::Tx { line: realtime_name(byte), realtime: true, ts: now_ms() });
        }
    }

    fn flush(&self, reason: &str) {
        let now = Instant::now();
        let (result, progress) = {
            let mut e = self.engine();
            let r = e.flush(reason, now);
            (r, e.job.as_ref().map(|j| j.progress(now)))
        };
        if result.dropped_commands > 0 || result.job_ended.is_some() {
            self.sink.emit(LinkEvent::Queue { pending: 0, in_flight: false, dropped: result.dropped_commands });
        }
        if let (Some(_), Some(p)) = (result.job_ended, progress) {
            self.snapshot.lock().expect("snapshot lock").job = Some(p.clone());
            self.sink.emit(LinkEvent::Job { progress: p });
        }
    }

    /// Soft reset. The byte is written and the queue flushed under the engine
    /// lock, so no queued line can be written after the reset byte.
    fn reset_now(&self, reason: &str) {
        let now = Instant::now();
        let (result, progress) = {
            let mut e = self.engine();
            if self.write(&[realtime::SOFT_RESET]).is_ok() {
                self.sink.emit(LinkEvent::Tx { line: realtime_name(realtime::SOFT_RESET), realtime: true, ts: now_ms() });
            }
            let r = e.flush(reason, now);
            (r, e.job.as_ref().map(|j| j.progress(now)))
        };
        self.sink.emit(LinkEvent::Queue { pending: 0, in_flight: false, dropped: result.dropped_commands });
        if let (Some(_), Some(p)) = (result.job_ended, progress) {
            self.snapshot.lock().expect("snapshot lock").job = Some(p.clone());
            self.sink.emit(LinkEvent::Job { progress: p });
        }
    }

    fn queue_identify(&self) {
        self.identified.store(true, Ordering::SeqCst);
        let mut e = self.engine();
        for c in IDENTIFY_COMMANDS {
            e.queue_command(c.to_string());
        }
        drop(e);
        self.kick();
    }

    fn status_state(&self) -> Option<MachineState> {
        self.snapshot.lock().expect("snapshot lock").status.as_ref().and_then(|s| s.state.clone())
    }
}

fn set_state(snapshot: &Mutex<LinkSnapshot>, sink: &dyn EventSink, state: LinkState, description: Option<String>, message: Option<String>) {
    {
        let mut s = snapshot.lock().expect("snapshot lock");
        s.state = state;
        if description.is_some() {
            s.description = description.clone();
        }
        if state == LinkState::Disconnected {
            s.description = None;
            s.firmware = None;
            s.status = None;
            s.controller = ControllerInfo::default();
        }
    }
    sink.emit(LinkEvent::State { state, description, message });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Active {
    shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
    max_queue: usize,
    max_line_len: usize,
}

pub struct Link {
    sink: Arc<dyn EventSink>,
    snapshot: Arc<Mutex<LinkSnapshot>>,
    active: Mutex<Option<Active>>,
}

impl Link {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Link { sink, snapshot: Arc::new(Mutex::new(LinkSnapshot::default())), active: Mutex::new(None) }
    }

    pub fn snapshot(&self) -> LinkSnapshot {
        self.snapshot.lock().expect("snapshot lock").clone()
    }

    fn shared(&self) -> Result<Arc<Shared>, LinkError> {
        let active = self.active.lock().expect("active lock");
        active
            .as_ref()
            .filter(|a| !a.shared.stop.load(Ordering::SeqCst))
            .map(|a| a.shared.clone())
            .ok_or(LinkError::NotConnected)
    }

    pub fn connect(&self, factory: Arc<dyn TransportFactory>, opts: LinkOptions) -> Result<(), LinkError> {
        let mut active = self.active.lock().expect("active lock");
        if let Some(a) = active.as_ref() {
            if !a.shared.stop.load(Ordering::SeqCst) {
                return Err(LinkError::AlreadyConnected);
            }
            if let Some(a) = active.take() {
                join_all(a);
            }
        }
        set_state(&self.snapshot, self.sink.as_ref(), LinkState::Connecting, Some(factory.describe()), None);
        let pair = match factory.open() {
            Ok(p) => p,
            Err(e) => {
                let msg = e.to_string();
                set_state(&self.snapshot, self.sink.as_ref(), LinkState::Disconnected, None, Some(msg.clone()));
                return Err(LinkError::Open(msg));
            }
        };
        let (kick_tx, kick_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            writer: Mutex::new(Some(pair.writer)),
            stop: AtomicBool::new(false),
            firmware_seen: AtomicBool::new(false),
            identified: AtomicBool::new(false),
            engine: Mutex::new(Engine::new(opts.char_counting, opts.rx_buffer)),
            snapshot: self.snapshot.clone(),
            sink: self.sink.clone(),
            kick: Mutex::new(kick_tx),
            controller_dirty: AtomicBool::new(false),
        });
        {
            let mut s = self.snapshot.lock().expect("snapshot lock");
            s.firmware = None;
            s.status = None;
            s.job = None;
            s.controller = ControllerInfo { rx_buffer: opts.rx_buffer, char_counting: opts.char_counting, ..ControllerInfo::default() };
        }
        let reader_thread = {
            let shared = shared.clone();
            let opts = opts.clone();
            let reader = pair.reader;
            thread::Builder::new()
                .name("grbl-reader".into())
                .spawn(move || reader_loop(shared, reader, factory, opts))
                .map_err(|e| LinkError::Io(e.to_string()))?
        };
        let worker_thread = {
            let shared = shared.clone();
            let opts = opts.clone();
            thread::Builder::new()
                .name("grbl-worker".into())
                .spawn(move || worker_loop(shared, kick_rx, opts))
                .map_err(|e| LinkError::Io(e.to_string()))?
        };
        shared.set_state(LinkState::Connected, Some(pair.description), None);
        *active = Some(Active { shared, threads: vec![reader_thread, worker_thread], max_queue: opts.max_queue, max_line_len: opts.max_line_len });
        Ok(())
    }

    pub fn disconnect(&self) {
        let taken = self.active.lock().expect("active lock").take();
        if let Some(a) = taken {
            a.shared.flush("disconnected by user");
            join_all(a);
        }
        set_state(&self.snapshot, self.sink.as_ref(), LinkState::Disconnected, None, None);
    }

    /// Queue one interactive line (console, buttons, jog steps).
    pub fn send_line(&self, line: &str) -> Result<(), LinkError> {
        let (max_queue, max_len) = {
            let active = self.active.lock().expect("active lock");
            let a = active.as_ref().ok_or(LinkError::NotConnected)?;
            (a.max_queue, a.max_line_len)
        };
        let shared = self.shared()?;
        let line = validate_line(line, max_len)?;
        {
            let mut e = shared.engine();
            if let Some(job) = e.job.as_ref().filter(|j| j.phase.is_active()) {
                let paused = matches!(job.phase, JobPhase::Paused | JobPhase::PausedOnError);
                if !paused || !READ_ONLY.contains(&line.as_str()) {
                    return Err(LinkError::Busy(if paused {
                        "a job is paused — only read-only queries ($$, $#, $G, $I) are allowed until it is resumed or stopped".into()
                    } else {
                        "a job is running — pause or stop it first".into()
                    }));
                }
            }
            if e.jogging() {
                return Err(LinkError::Busy("release the jog control first".into()));
            }
            if e.pending_commands() >= max_queue {
                return Err(LinkError::QueueFull(max_queue));
            }
            e.queue_command(line);
        }
        shared.kick();
        Ok(())
    }

    /// Write a real-time command byte immediately. Feed hold / cycle start
    /// also pause / resume a running job so its state stays consistent.
    pub fn send_realtime(&self, byte: u8) -> Result<(), LinkError> {
        if !realtime::is_realtime(byte) {
            return Err(LinkError::InvalidLine(format!("0x{byte:02X} is not a GRBL real-time command")));
        }
        let shared = self.shared()?;
        if byte == realtime::SOFT_RESET {
            shared.reset_now("soft reset");
            shared.kick();
            return Ok(());
        }
        shared.write(&[byte]).map_err(|e| LinkError::Io(e.to_string()))?;
        {
            let now = Instant::now();
            let mut e = shared.engine();
            match byte {
                realtime::FEED_HOLD => {
                    e.pause_job(now);
                }
                realtime::CYCLE_START => {
                    e.resume_job(now);
                }
                realtime::JOG_CANCEL => e.jog_stop(),
                _ => {}
            }
        }
        if byte != realtime::STATUS_REPORT {
            self.sink.emit(LinkEvent::Tx { line: realtime_name(byte), realtime: true, ts: now_ms() });
        }
        shared.kick();
        Ok(())
    }

    // ----- jobs ---------------------------------------------------------------

    pub fn start_job(&self, name: String, lines: Vec<PreparedLine>, mode: JobMode) -> Result<(), LinkError> {
        let shared = self.shared()?;
        match shared.status_state() {
            Some(MachineState::Idle) => {}
            Some(other) => return Err(LinkError::Busy(format!("the machine must be Idle to start a job (it is {other:?})"))),
            None => return Err(LinkError::Busy("waiting for the first status report".into())),
        }
        {
            let mut e = shared.engine();
            if e.job_active() {
                return Err(LinkError::Busy("a job is already running".into()));
            }
            if e.jogging() || e.pending_commands() > 0 || e.in_flight_len() > 0 {
                return Err(LinkError::Busy("wait for pending commands to finish".into()));
            }
            e.start_job(Job::new(name, lines, mode, Instant::now()));
        }
        shared.kick();
        Ok(())
    }

    pub fn pause_job(&self) -> Result<(), LinkError> {
        let shared = self.shared()?;
        let mode = {
            let mut e = shared.engine();
            if !e.pause_job(Instant::now()) {
                return Err(LinkError::Busy("no running job to pause".into()));
            }
            e.job.as_ref().map(|j| j.mode)
        };
        if mode == Some(JobMode::Run) {
            shared.realtime(realtime::FEED_HOLD);
        }
        shared.kick();
        Ok(())
    }

    pub fn resume_job(&self) -> Result<(), LinkError> {
        let shared = self.shared()?;
        let mode = {
            let mut e = shared.engine();
            if !e.resume_job(Instant::now()) {
                return Err(LinkError::Busy("no paused job to resume".into()));
            }
            e.job.as_ref().map(|j| j.mode)
        };
        if mode == Some(JobMode::Run) {
            shared.realtime(realtime::CYCLE_START);
        }
        shared.kick();
        Ok(())
    }

    pub fn stop_job(&self) -> Result<(), LinkError> {
        let shared = self.shared()?;
        let mode = {
            let mut e = shared.engine();
            if !e.request_stop(Instant::now()) {
                return Err(LinkError::Busy("no job to stop".into()));
            }
            e.job.as_ref().map(|j| j.mode)
        };
        if mode == Some(JobMode::Run) {
            shared.realtime(realtime::FEED_HOLD);
        }
        shared.kick();
        Ok(())
    }

    // ----- jogging ------------------------------------------------------------

    pub fn jog_start(&self, dir: [f64; 3], feed: f64, accel: f64) -> Result<(), LinkError> {
        let shared = self.shared()?;
        match shared.status_state() {
            Some(MachineState::Idle) | Some(MachineState::Jog) => {}
            Some(other) => return Err(LinkError::Busy(format!("jogging needs the machine Idle (it is {other:?})"))),
            None => return Err(LinkError::Busy("waiting for the first status report".into())),
        }
        {
            let mut e = shared.engine();
            if e.job_active() {
                return Err(LinkError::Busy("cannot jog while a job is active".into()));
            }
            e.jog_start(dir, feed, accel, Instant::now());
        }
        shared.kick();
        Ok(())
    }

    pub fn jog_heartbeat(&self) {
        if let Ok(shared) = self.shared() {
            shared.engine().jog_heartbeat(Instant::now());
            shared.kick();
        }
    }

    pub fn jog_stop(&self) {
        if let Ok(shared) = self.shared() {
            shared.engine().jog_stop();
            shared.kick();
        }
    }

    /// Re-read `$$`, `$#`, `$G` (and `$I`).
    pub fn refresh_controller(&self) -> Result<(), LinkError> {
        let shared = self.shared()?;
        if shared.engine().job_active() {
            return Err(LinkError::Busy("not while a job is active".into()));
        }
        shared.queue_identify();
        Ok(())
    }

    /// Test/diagnostic accessor.
    pub fn in_flight_bytes(&self) -> usize {
        self.shared().map(|s| s.engine().in_flight_bytes()).unwrap_or(0)
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        if let Ok(mut a) = self.active.lock() {
            if let Some(a) = a.take() {
                join_all(a);
            }
        }
    }
}

fn join_all(a: Active) {
    a.shared.stop.store(true, Ordering::SeqCst);
    a.shared.kick();
    for t in a.threads {
        let _ = t.join();
    }
    *a.shared.writer.lock().expect("writer lock") = None;
}

/// Basic checks before anything is queued.
pub fn validate_line(line: &str, max_len: usize) -> Result<String, LinkError> {
    let t = line.trim();
    if t.is_empty() {
        return Err(LinkError::InvalidLine("empty line".into()));
    }
    if t.contains(['\n', '\r']) {
        return Err(LinkError::InvalidLine("send one line at a time".into()));
    }
    if let Some(c) = t.chars().find(|c| matches!(c, '?' | '!' | '~') || (*c as u32) >= 0x80 || ((*c as u32) < 0x20 && *c != '\t')) {
        return Err(LinkError::InvalidLine(format!(
            "'{}' is a GRBL real-time character and would act immediately instead of being part of this line",
            c.escape_default()
        )));
    }
    if t.len() > max_len {
        return Err(LinkError::InvalidLine(format!("line is {} characters; the limit is {max_len}", t.len())));
    }
    Ok(t.to_string())
}

pub fn realtime_name(b: u8) -> String {
    match b {
        realtime::STATUS_REPORT => "?".into(),
        realtime::FEED_HOLD => "! (feed hold)".into(),
        realtime::CYCLE_START => "~ (cycle start)".into(),
        realtime::SOFT_RESET => "Ctrl-X (soft reset)".into(),
        realtime::JOG_CANCEL => "Jog cancel".into(),
        realtime::SAFETY_DOOR => "Safety door".into(),
        0x90..=0x94 => format!("Feed override 0x{b:02X}"),
        0x95..=0x97 => format!("Rapid override 0x{b:02X}"),
        0x99..=0x9E => format!("Spindle override 0x{b:02X}"),
        0xA0 => "Flood toggle".into(),
        0xA1 => "Mist toggle".into(),
        _ => format!("Real-time 0x{b:02X}"),
    }
}

fn reader_loop(shared: Arc<Shared>, mut reader: Box<dyn ByteReader>, factory: Arc<dyn TransportFactory>, opts: LinkOptions) {
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::with_capacity(256);
    let mut tracker = StatusTracker::new();
    'outer: while !shared.stop.load(Ordering::SeqCst) {
        match reader.read(&mut buf) {
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\n' {
                        handle_line(&shared, &mut tracker, &line);
                        line.clear();
                    } else if b != b'\r' {
                        line.push(b);
                        if line.len() > 4096 {
                            handle_line(&shared, &mut tracker, &line);
                            line.clear();
                        }
                    }
                }
            }
            Err(e) => {
                if shared.stop.load(Ordering::SeqCst) {
                    break;
                }
                *shared.writer.lock().expect("writer lock") = None;
                shared.flush("connection lost");
                line.clear();
                shared.set_state(LinkState::Lost, None, Some(format!("Connection lost: {e}. Any running job was stopped; nothing will be re-sent.")));
                if !opts.auto_reconnect {
                    break;
                }
                for attempt in 1..=opts.reconnect_attempts {
                    shared.set_state(LinkState::Reconnecting, None, Some(format!("Reconnecting (attempt {attempt} of {})…", opts.reconnect_attempts)));
                    let deadline = Instant::now() + opts.reconnect_interval;
                    while Instant::now() < deadline {
                        if shared.stop.load(Ordering::SeqCst) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    if let Ok(pair) = factory.open() {
                        reader = pair.reader;
                        *shared.writer.lock().expect("writer lock") = Some(pair.writer);
                        tracker.reset();
                        shared.firmware_seen.store(false, Ordering::SeqCst);
                        shared.identified.store(false, Ordering::SeqCst);
                        shared.set_state(
                            LinkState::Connected,
                            Some(pair.description),
                            Some("Reconnected. The controller has probably reset — check its position before continuing.".into()),
                        );
                        continue 'outer;
                    }
                }
                break;
            }
        }
    }
    if !shared.stop.swap(true, Ordering::SeqCst) {
        shared.set_state(LinkState::Disconnected, None, Some("Disconnected: the controller could not be reached.".into()));
    }
    shared.kick();
}

fn set_firmware(shared: &Shared, info: FirmwareInfo) {
    shared.firmware_seen.store(true, Ordering::SeqCst);
    shared.snapshot.lock().expect("snapshot lock").firmware = Some(info.clone());
    shared.sink.emit(LinkEvent::Firmware { info });
}

fn handle_line(shared: &Shared, tracker: &mut StatusTracker, raw: &[u8]) {
    let text = String::from_utf8_lossy(raw).trim().to_string();
    if text.is_empty() {
        return;
    }
    let parsed = parse_line(&text);
    let ts = now_ms();
    let now = Instant::now();
    let mut is_ack = None;
    match &parsed {
        GrblLine::Status { report } => {
            let st = tracker.apply(report).clone();
            let idle = matches!(st.state, Some(MachineState::Idle));
            shared.snapshot.lock().expect("snapshot lock").status = Some(st.clone());
            shared.sink.emit(LinkEvent::Status { status: st, ts });
            if idle && shared.engine().on_status_idle(now) {
                shared.kick();
            }
        }
        GrblLine::Welcome { info } => {
            tracker.reset();
            shared.flush("the controller reset");
            {
                let mut s = shared.snapshot.lock().expect("snapshot lock");
                s.controller.settings.clear();
                s.controller.offsets.clear();
            }
            set_firmware(shared, info.clone());
            shared.queue_identify();
        }
        GrblLine::Ok => is_ack = Some(None),
        GrblLine::Error { code, text } => is_ack = Some(Some((*code, text.clone()))),
        GrblLine::Alarm { code, text } => {
            let what = code.map(|c| format!("ALARM:{c}")).unwrap_or_else(|| format!("alarm ({text})"));
            shared.flush(&what);
        }
        GrblLine::Setting { id, value } => {
            shared.snapshot.lock().expect("snapshot lock").controller.settings.insert(*id, value.clone());
            shared.controller_dirty.store(true, Ordering::SeqCst);
        }
        GrblLine::Offset { name, values } => {
            shared.snapshot.lock().expect("snapshot lock").controller.offsets.insert(name.clone(), values.clone());
            shared.controller_dirty.store(true, Ordering::SeqCst);
        }
        GrblLine::Probe { position, success } => {
            shared.snapshot.lock().expect("snapshot lock").controller.probe = Some(ProbeResult { position: position.clone(), success: *success });
            shared.controller_dirty.store(true, Ordering::SeqCst);
        }
        GrblLine::ParserState { words } => {
            shared.snapshot.lock().expect("snapshot lock").controller.parser_state = words.clone();
            shared.controller_dirty.store(true, Ordering::SeqCst);
        }
        GrblLine::Version { text } => absorb_build(shared, "VER", text),
        GrblLine::Options { text } => absorb_build(shared, "OPT", text),
        GrblLine::Feedback { text } => {
            if let Some((k, v)) = text.split_once(':') {
                if k == "FIRMWARE" {
                    absorb_build(shared, k, v);
                }
            }
            if let Some(v) = parse_legacy_build(text) {
                if !shared.firmware_seen.load(Ordering::SeqCst) {
                    if let Some(info) = parse_welcome(&format!("Grbl {v}")) {
                        set_firmware(shared, info);
                    }
                }
            }
        }
        _ => {}
    }
    shared.sink.emit(LinkEvent::Rx { line: text, parsed, ts });
    if let Some(err) = is_ack {
        let event = shared.engine().on_ack(err, now);
        if matches!(event, AckEvent::JobErrorPaused(_)) {
            shared.realtime(realtime::FEED_HOLD);
        }
        if shared.controller_dirty.swap(false, Ordering::SeqCst) {
            let info = shared.snapshot.lock().expect("snapshot lock").controller.clone();
            shared.sink.emit(LinkEvent::Controller { info });
        }
        shared.kick();
    }
}

fn absorb_build(shared: &Shared, key: &str, value: &str) {
    let build = {
        let mut s = shared.snapshot.lock().expect("snapshot lock");
        s.controller.build.absorb(key, value);
        if key == "OPT" {
            if let Some(rx) = s.controller.build.rx_buffer {
                s.controller.rx_buffer = rx as usize;
            }
        }
        s.controller.build.clone()
    };
    if key == "OPT" {
        if let Some(rx) = build.rx_buffer {
            shared.engine().set_rx_buffer(rx as usize);
        }
    }
    shared.controller_dirty.store(true, Ordering::SeqCst);
    // Boards that don't reset on connect never print a banner: identify from $I.
    let banner_kind_mismatch = {
        let s = shared.snapshot.lock().expect("snapshot lock");
        s.firmware.as_ref().is_some_and(|f| build.grblhal && f.kind != grbl_core::firmware::FirmwareKind::Grblhal)
    };
    if !shared.firmware_seen.load(Ordering::SeqCst) || banner_kind_mismatch {
        if let Some(info) = build.to_firmware() {
            set_firmware(shared, info);
        }
    }
}

fn worker_loop(shared: Arc<Shared>, kick: mpsc::Receiver<()>, opts: LinkOptions) {
    let interval = Duration::from_secs_f64(1.0 / opts.poll_hz.clamp(1.0, 20.0));
    let mut next_poll = Instant::now() + interval;
    let identify_at = Instant::now() + opts.identify_after;
    let mut last_progress = Instant::now();
    let mut last_phase: Option<JobPhase> = None;
    let mut last_queue = (usize::MAX, false);
    while !shared.stop.load(Ordering::SeqCst) {
        let busy = {
            let e = shared.engine();
            e.jogging() || e.job.as_ref().is_some_and(|j| j.phase == JobPhase::Stopping)
        };
        let wait = if busy { Duration::from_millis(10) } else { next_poll.saturating_duration_since(Instant::now()).clamp(Duration::from_millis(1), Duration::from_millis(100)) };
        match kick.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let now = Instant::now();
        if now >= next_poll {
            let _ = shared.write(b"?");
            next_poll = now + interval;
        }
        if !shared.identified.load(Ordering::SeqCst) && now >= identify_at {
            shared.queue_identify();
        }

        // Job stop sequence: hold was sent; reset once stopped (or timeout).
        let reset_due = {
            let e = shared.engine();
            e.job.as_ref().is_some_and(|j| {
                j.phase == JobPhase::Stopping
                    && !j.reset_sent
                    && (j.mode == JobMode::Check
                        || j.stop_requested_at.is_some_and(|t| now.saturating_duration_since(t) >= STOP_RESET_TIMEOUT)
                        || matches!(shared.status_state(), Some(MachineState::Hold(0) | MachineState::Idle | MachineState::Alarm)))
            })
        };
        if reset_due {
            if let Some(j) = shared.engine().job.as_mut() {
                j.reset_sent = true;
            }
            shared.reset_now("stopped by user");
        }

        // Pump the engine.
        {
            let mut e = shared.engine();
            while let Some(out) = e.poll(now) {
                match out {
                    Outgoing::Line { text, origin } => {
                        let mut bytes = text.clone().into_bytes();
                        bytes.push(b'\n');
                        if let Err(err) = shared.write(&bytes) {
                            log::warn!("write failed: {err}");
                            break;
                        }
                        if matches!(origin, Origin::Command | Origin::JobControl) {
                            shared.sink.emit(LinkEvent::Tx { line: text, realtime: false, ts: now_ms() });
                        }
                    }
                    Outgoing::Realtime(b) => {
                        if shared.write(&[b]).is_ok() {
                            shared.sink.emit(LinkEvent::Tx { line: realtime_name(b), realtime: true, ts: now_ms() });
                        }
                    }
                }
            }
            let q = (e.pending_commands(), e.in_flight_len() > 0);
            if q != last_queue {
                last_queue = q;
                shared.sink.emit(LinkEvent::Queue { pending: q.0, in_flight: q.1, dropped: 0 });
            }
            if let Some(job) = &e.job {
                let changed = last_phase != Some(job.phase);
                if changed || (job.phase.is_active() && now.saturating_duration_since(last_progress) >= Duration::from_millis(200)) {
                    last_phase = Some(job.phase);
                    last_progress = now;
                    let p = job.progress(now);
                    shared.snapshot.lock().expect("snapshot lock").job = Some(p.clone());
                    shared.sink.emit(LinkEvent::Job { progress: p });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the JSON shape the frontend relies on (src/lib/backend/types.ts).
    #[test]
    fn event_json_matches_frontend_contract() {
        let ev = LinkEvent::Queue { pending: 2, in_flight: true, dropped: 0 };
        assert_eq!(serde_json::to_value(&ev).unwrap(), serde_json::json!({"type": "queue", "pending": 2, "inFlight": true, "dropped": 0}));
        let ev = LinkEvent::State { state: LinkState::Reconnecting, description: None, message: Some("x".into()) };
        assert_eq!(serde_json::to_value(&ev).unwrap(), serde_json::json!({"type": "state", "state": "reconnecting", "description": null, "message": "x"}));
        let mut t = StatusTracker::new();
        let st = t.apply(&grbl_core::status::parse_status("<Hold:0|MPos:1,2,3|FS:10,20|WCO:0,0,0>").unwrap()).clone();
        let v = serde_json::to_value(LinkEvent::Status { status: st, ts: 1 }).unwrap();
        assert_eq!(v["type"], "status");
        assert_eq!(v["status"]["state"], serde_json::json!({"name": "hold", "sub": 0}));
        assert_eq!(v["status"]["mpos"], serde_json::json!([1.0, 2.0, 3.0]));
        assert_eq!(v["status"]["overrides"], serde_json::json!({"feed": 100, "rapid": 100, "spindle": 100}));
        assert!(v["status"]["accessories"].get("spindleCw").is_some());
        let idle = serde_json::to_value(grbl_core::status::MachineState::Idle).unwrap();
        assert_eq!(idle, serde_json::json!({"name": "idle"}));
        let line = serde_json::to_value(LinkEvent::Rx { line: "[GC:G0]".into(), parsed: parse_line("[GC:G0]"), ts: 0 }).unwrap();
        assert_eq!(line["parsed"], serde_json::json!({"type": "parserState", "words": ["G0"]}));
        let mut info = ControllerInfo::default();
        info.settings.insert(110, "500.000".into());
        info.offsets.insert("G54".into(), vec![1.0, 2.0, 3.0]);
        let v = serde_json::to_value(LinkEvent::Controller { info }).unwrap();
        assert_eq!(v["info"]["settings"]["110"], "500.000");
        assert_eq!(v["info"]["offsets"]["G54"], serde_json::json!([1.0, 2.0, 3.0]));
        assert!(v["info"].get("parserState").is_some() && v["info"].get("charCounting").is_some());
        let job = Job::new("a.nc".into(), vec![], JobMode::Check, Instant::now());
        let v = serde_json::to_value(LinkEvent::Job { progress: job.progress(Instant::now()) }).unwrap();
        assert_eq!(v["progress"]["phase"], "starting");
        assert_eq!(v["progress"]["mode"], "check");
        assert!(v["progress"].get("currentLine").is_some() && v["progress"].get("elapsedMs").is_some());
    }

    #[test]
    fn validates_lines() {
        assert_eq!(validate_line("  G0 X1  ", 80).unwrap(), "G0 X1");
        assert!(validate_line("", 80).is_err());
        assert!(validate_line("G0 (why?) X1", 80).is_err());
        assert!(validate_line("G0\nX1", 80).is_err());
        assert!(validate_line(&"G".repeat(100), 80).is_err());
    }
}
