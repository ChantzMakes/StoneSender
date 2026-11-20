//! The streaming engine: decides *what* to send next and tracks what is in
//! flight. It is pure logic (no threads, no I/O) so it can be unit-tested
//! exhaustively; `link.rs` drives it.
//!
//! ## Character counting
//! GRBL acknowledges every line with `ok`/`error`. We keep a FIFO of the byte
//! length (incl. `\n`) of every unacknowledged line; a new line may be sent
//! only if `in_flight_bytes + len <= rx_capacity`. Each ack pops the oldest.
//! `rx_capacity` is the controller's RX buffer minus one (GRBL's ring buffer
//! keeps one slot empty — matches `stream.py` in the GRBL repo).
//!
//! `$` system commands (except `$J=`) are always sent alone, send-response
//! style, because GRBL writes EEPROM for them with interrupts disabled and can
//! drop serial bytes. Send-response mode applies that rule to every line.
//!
//! ## Jogging
//! Continuous jogging sends short `$J=` chunks while the UI keeps sending
//! heartbeats. On release (or if heartbeats stop for `JOG_HEARTBEAT_TIMEOUT`)
//! no new chunks are generated; once every chunk already sent has been
//! acknowledged (i.e. is in GRBL's planner, not its RX buffer) a jog-cancel
//! (0x85) is emitted, which stops motion and flushes the planned chunks. This
//! guarantees no stale jog line can execute after the cancel.

use grbl_core::gcode_prep::{PreparedLine, ToolChange};
use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const JOG_HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(350);
const JOG_MAX_IN_FLIGHT: usize = 3;
const JOG_CHUNK_SECS: f64 = 0.1;
const MAX_REPORTED_ERRORS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Interactive line; tracked ones carry an id the UI waits on
    Command(Option<u64>),
    /// Lines the app adds around a job (e.g. `$C` for check mode)
    JobControl,
    Job(usize),
    Jog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobMode {
    /// Normal run
    Run,
    /// Dry run with `$C`: GRBL parses everything, nothing moves
    Check,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobPhase {
    Starting,
    Running,
    Paused,
    PausedOnError,
    /// Everything acknowledged; waiting for the machine to finish moving
    Finishing,
    Stopping,
    /// Stopped before an M6 line: everything before it has been acknowledged.
    /// The UI guides the tool change (interactive commands are allowed), then
    /// calls `tool_change_done`.
    ToolChange,
    Completed,
    Stopped,
    Failed,
}

/// What a run does at M6 lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolChangeMode {
    /// Stop before the line and wait for a guided tool change
    #[default]
    Pause,
    /// Send the line without M6 and carry on (profile says "ignore M6")
    Skip,
}

impl JobPhase {
    pub fn is_active(self) -> bool {
        !matches!(self, JobPhase::Completed | JobPhase::Stopped | JobPhase::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub source_line: u32,
    pub code: Option<u16>,
    pub text: String,
    pub line_text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub name: String,
    pub mode: JobMode,
    pub phase: JobPhase,
    pub total: usize,
    pub sent: usize,
    pub acked: usize,
    /// Source line of the most recently acknowledged job line
    pub current_line: u32,
    pub elapsed_ms: u64,
    pub error_count: usize,
    pub errors: Vec<JobError>,
    pub message: Option<String>,
    /// Set while the job waits for a tool change
    pub tool_change: Option<ToolChange>,
    /// Number of recovery lines sent before the job (start from line)
    pub prelude_lines: usize,
}

#[derive(Debug)]
pub struct Job {
    pub name: String,
    lines: Vec<PreparedLine>,
    next: usize,
    acked: usize,
    pub mode: JobMode,
    pub phase: JobPhase,
    prelude: VecDeque<String>,
    postlude: VecDeque<String>,
    errors: Vec<JobError>,
    error_count: usize,
    started: Instant,
    paused_total: Duration,
    paused_at: Option<Instant>,
    finishing_since: Option<Instant>,
    ended_at: Option<Instant>,
    last_source_line: u32,
    pub message: Option<String>,
    pub stop_requested_at: Option<Instant>,
    pub reset_sent: bool,
    pub tool_change_mode: ToolChangeMode,
    /// Index of the M6 line whose tool change is done (send it now)
    tool_change_cleared: Option<usize>,
    pending_tool_change: Option<ToolChange>,
    prelude_total: usize,
}

impl Job {
    pub fn new(name: String, lines: Vec<PreparedLine>, mode: JobMode, now: Instant) -> Self {
        let (prelude, postlude) = match mode {
            JobMode::Run => (VecDeque::new(), VecDeque::new()),
            JobMode::Check => (VecDeque::from(["$C".to_string()]), VecDeque::from(["$C".to_string()])),
        };
        Job {
            name,
            lines,
            next: 0,
            acked: 0,
            mode,
            phase: JobPhase::Starting,
            prelude,
            postlude,
            errors: Vec::new(),
            error_count: 0,
            started: now,
            paused_total: Duration::ZERO,
            paused_at: None,
            finishing_since: None,
            ended_at: None,
            last_source_line: 0,
            message: None,
            stop_requested_at: None,
            reset_sent: false,
            tool_change_mode: ToolChangeMode::Pause,
            tool_change_cleared: None,
            pending_tool_change: None,
            prelude_total: 0,
        }
    }

    /// Recovery lines sent (one at a time) before the first job line — used
    /// to start from a line with the right modal state. Run mode only.
    pub fn with_prelude(mut self, lines: Vec<String>) -> Self {
        if self.mode == JobMode::Run {
            self.prelude_total = lines.len();
            self.prelude.extend(lines);
        }
        self
    }

    pub fn with_tool_change_mode(mut self, mode: ToolChangeMode) -> Self {
        self.tool_change_mode = mode;
        self
    }

    pub fn progress(&self, now: Instant) -> JobProgress {
        let end = self.ended_at.unwrap_or(now);
        let paused = self.paused_total + self.paused_at.map(|p| end.saturating_duration_since(p)).unwrap_or_default();
        JobProgress {
            name: self.name.clone(),
            mode: self.mode,
            phase: self.phase,
            total: self.lines.len(),
            sent: self.next,
            acked: self.acked,
            current_line: self.last_source_line,
            elapsed_ms: end.saturating_duration_since(self.started).saturating_sub(paused).as_millis() as u64,
            error_count: self.error_count,
            errors: self.errors.clone(),
            message: self.message.clone(),
            tool_change: self.pending_tool_change.clone(),
            prelude_lines: self.prelude_total,
        }
    }

    fn end(&mut self, phase: JobPhase, message: Option<String>, now: Instant) {
        if let Some(p) = self.paused_at.take() {
            self.paused_total += now.saturating_duration_since(p);
        }
        self.phase = phase;
        self.message = message;
        self.ended_at = Some(now);
    }
}

struct JogRun {
    /// mm per chunk per axis
    chunk: [f64; 3],
    feed: f64,
    last_beat: Instant,
    stopping: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outgoing {
    Line { text: String, origin: Origin },
    Realtime(u8),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AckEvent {
    /// Nothing was in flight (stray ok, e.g. from a line sent before connect)
    Unexpected,
    Command { error: Option<u16>, id: Option<u64> },
    Job,
    /// A job line failed in run mode: the job paused; send a feed hold.
    JobErrorPaused(JobError),
    /// A job line failed in check mode: recorded, streaming continues.
    JobErrorRecorded(JobError),
    JobControlFailed(String),
    Jog { error: Option<u16> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlushResult {
    pub dropped_commands: usize,
    /// Tracked commands that will never be acknowledged
    pub dropped_ids: Vec<u64>,
    pub job_ended: Option<JobPhase>,
}

pub struct Engine {
    pub char_counting: bool,
    pub rx_capacity: usize,
    in_flight: VecDeque<(usize, Origin, bool)>,
    in_flight_bytes: usize,
    commands: VecDeque<(String, Option<u64>)>,
    pub job: Option<Job>,
    jog: Option<JogRun>,
}

fn is_system(line: &str) -> bool {
    line.starts_with('$') && !line.starts_with("$J=")
}

impl Engine {
    pub fn new(char_counting: bool, rx_buffer: usize) -> Self {
        Engine {
            char_counting,
            rx_capacity: rx_buffer.saturating_sub(1).max(16),
            in_flight: VecDeque::new(),
            in_flight_bytes: 0,
            commands: VecDeque::new(),
            job: None,
            jog: None,
        }
    }

    pub fn set_rx_buffer(&mut self, rx_buffer: usize) {
        self.rx_capacity = rx_buffer.saturating_sub(1).max(16);
    }

    pub fn in_flight_bytes(&self) -> usize {
        self.in_flight_bytes
    }
    pub fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }
    pub fn pending_commands(&self) -> usize {
        self.commands.len()
    }
    pub fn job_active(&self) -> bool {
        self.job.as_ref().is_some_and(|j| j.phase.is_active())
    }
    pub fn jogging(&self) -> bool {
        self.jog.is_some()
    }

    pub fn queue_command(&mut self, line: String) {
        self.commands.push_back((line, None));
    }

    /// Queue a line whose acknowledgement the caller waits for (`AckEvent::Command { id }`).
    pub fn queue_tracked(&mut self, line: String, id: u64) {
        self.commands.push_back((line, Some(id)));
    }

    pub fn job_phase(&self) -> Option<JobPhase> {
        self.job.as_ref().map(|j| j.phase)
    }

    pub fn start_job(&mut self, job: Job) {
        self.job = Some(job);
    }

    fn can_send(&self, len: usize, system: bool) -> bool {
        if self.in_flight.iter().any(|(_, _, s)| *s) {
            return false;
        }
        if system || !self.char_counting {
            return self.in_flight.is_empty();
        }
        let with_newline = len + 1;
        self.in_flight_bytes + with_newline <= self.rx_capacity
    }

    fn take(&mut self, text: String, origin: Origin) -> Outgoing {
        let sys = is_system(&text);
        self.in_flight.push_back((text.len() + 1, origin, sys));
        self.in_flight_bytes += text.len() + 1;
        Outgoing::Line { text, origin }
    }

    /// Next thing to write, if any. Call repeatedly until `None`.
    pub fn poll(&mut self, now: Instant) -> Option<Outgoing> {
        // --- jog stop / watchdog
        if let Some(j) = &mut self.jog {
            if !j.stopping && now.saturating_duration_since(j.last_beat) > JOG_HEARTBEAT_TIMEOUT {
                j.stopping = true;
            }
            if j.stopping && !self.in_flight.iter().any(|(_, o, _)| *o == Origin::Jog) {
                self.jog = None;
                return Some(Outgoing::Realtime(grbl_core::realtime::JOG_CANCEL));
            }
        }

        // --- job
        let control_in_flight = self.in_flight.iter().any(|(_, o, _)| *o == Origin::JobControl);
        match self.job.as_ref().map(|j| j.phase) {
            Some(JobPhase::Starting) => {
                let front = self.job.as_ref()?.prelude.front().map(|l| (l.len(), is_system(l)));
                if let Some((len, sys)) = front {
                    // Recovery lines go one at a time so a rejected line stops the rest.
                    let one_at_a_time = self.job.as_ref()?.prelude_total > 0;
                    if self.can_send(len, sys) && (!one_at_a_time || self.in_flight.is_empty()) {
                        let l = self.job.as_mut()?.prelude.pop_front()?;
                        return Some(self.take(l, Origin::JobControl));
                    }
                    return None;
                }
                if control_in_flight {
                    return None;
                }
                self.job.as_mut()?.phase = JobPhase::Running;
                return self.poll(now);
            }
            Some(JobPhase::Running) => {
                let (next, total, acked) = {
                    let j = self.job.as_ref()?;
                    (j.next, j.lines.len(), j.acked)
                };
                if next < total {
                    let job = self.job.as_mut()?;
                    let line = &job.lines[next];
                    if line.tool_change.is_some() && job.mode == JobMode::Run && job.tool_change_mode == ToolChangeMode::Pause && job.tool_change_cleared != Some(next) {
                        if acked < next {
                            return None; // let everything before the M6 be acknowledged first
                        }
                        job.pending_tool_change = line.tool_change.clone();
                        job.phase = JobPhase::ToolChange;
                        job.paused_at = Some(now);
                        return self.poll(now);
                    }
                    if line.text.is_empty() {
                        // A line that only held M6: nothing to send.
                        job.next += 1;
                        job.acked += 1;
                        return self.poll(now);
                    }
                    let (len, sys) = {
                        let t = &self.job.as_ref()?.lines[next].text;
                        (t.len(), is_system(t))
                    };
                    if self.can_send(len, sys) {
                        let job = self.job.as_mut()?;
                        job.next += 1;
                        let text = job.lines[next].text.clone();
                        return Some(self.take(text, Origin::Job(next)));
                    }
                    return None;
                }
                if acked < total {
                    return None;
                }
                let front = self.job.as_ref()?.postlude.front().map(|l| (l.len(), is_system(l)));
                if let Some((len, sys)) = front {
                    if self.can_send(len, sys) {
                        let l = self.job.as_mut()?.postlude.pop_front()?;
                        return Some(self.take(l, Origin::JobControl));
                    }
                    return None;
                }
                if control_in_flight {
                    return None;
                }
                {
                    let job = self.job.as_mut()?;
                    match job.mode {
                        JobMode::Check => {
                            let msg = if job.error_count == 0 {
                                "Check finished: no errors.".to_string()
                            } else {
                                format!("Check finished: {} line(s) would fail.", job.error_count)
                            };
                            job.end(JobPhase::Completed, Some(msg), now);
                        }
                        JobMode::Run => {
                            job.phase = JobPhase::Finishing;
                            job.finishing_since = Some(now);
                        }
                    }
                }
                return None;
            }
            // Paused / tool change: fall through so interactive commands can run
            // (the link decides which ones are allowed).
            Some(JobPhase::Paused | JobPhase::PausedOnError | JobPhase::ToolChange) => {}
            Some(p) if p.is_active() => return None,
            _ => {}
        }

        // --- interactive commands (strict order)
        if let Some((c, _)) = self.commands.front() {
            let (len, sys) = (c.len(), is_system(c));
            if self.can_send(len, sys) {
                let (c, id) = self.commands.pop_front()?;
                return Some(self.take(c, Origin::Command(id)));
            }
            return None;
        }

        // --- continuous jog
        if let Some(j) = &self.jog {
            if !j.stopping && self.in_flight.iter().filter(|(_, o, _)| *o == Origin::Jog).count() < JOG_MAX_IN_FLIGHT {
                let mut line = String::from("$J=G91G21");
                for (axis, d) in ["X", "Y", "Z"].iter().zip(j.chunk) {
                    if d != 0.0 {
                        line.push_str(&format!("{axis}{d:.3}"));
                    }
                }
                line.push_str(&format!("F{:.0}", j.feed));
                if self.can_send(line.len(), false) {
                    return Some(self.take(line, Origin::Jog));
                }
            }
        }
        None
    }

    pub fn on_ack(&mut self, error: Option<(Option<u16>, String)>, now: Instant) -> AckEvent {
        let Some((len, origin, _)) = self.in_flight.pop_front() else {
            return AckEvent::Unexpected;
        };
        self.in_flight_bytes = self.in_flight_bytes.saturating_sub(len);
        let code = error.as_ref().and_then(|e| e.0);
        match origin {
            Origin::Command(id) => AckEvent::Command { error: code, id },
            Origin::Jog => {
                if error.is_some() {
                    if let Some(j) = &mut self.jog {
                        j.stopping = true;
                    }
                }
                AckEvent::Jog { error: code }
            }
            Origin::JobControl => {
                if let Some(job) = &mut self.job {
                    if let Some((code, text)) = &error {
                        if job.phase.is_active() {
                            let msg = if job.mode == JobMode::Check {
                                "The controller refused to enter check mode (it must be idle).".to_string()
                            } else {
                                let c = code.map(|c| format!("error:{c}")).unwrap_or_else(|| text.clone());
                                format!("The controller rejected a recovery line ({c}); the job did not start and nothing after it was sent.")
                            };
                            job.end(JobPhase::Failed, Some(msg.clone()), now);
                            return AckEvent::JobControlFailed(msg);
                        }
                    }
                }
                AckEvent::Job
            }
            Origin::Job(i) => {
                let Some(job) = &mut self.job else { return AckEvent::Job };
                job.acked += 1;
                job.last_source_line = job.lines.get(i).map(|l| l.source_line).unwrap_or(0);
                if let Some((code, text)) = error {
                    let e = JobError {
                        source_line: job.last_source_line,
                        code,
                        text,
                        line_text: job.lines.get(i).map(|l| l.text.clone()).unwrap_or_default(),
                    };
                    job.error_count += 1;
                    if job.errors.len() < MAX_REPORTED_ERRORS {
                        job.errors.push(e.clone());
                    }
                    if job.mode == JobMode::Run && matches!(job.phase, JobPhase::Running | JobPhase::Paused) {
                        job.phase = JobPhase::PausedOnError;
                        job.paused_at.get_or_insert(now);
                        return AckEvent::JobErrorPaused(e);
                    }
                    return AckEvent::JobErrorRecorded(e);
                }
                AckEvent::Job
            }
        }
    }

    /// The controller reset, alarmed or the connection dropped: nothing in
    /// flight will be acknowledged and nothing queued may be sent.
    pub fn flush(&mut self, reason: &str, now: Instant) -> FlushResult {
        // Interactive commands that were queued or sent but never acknowledged.
        let dropped = self.commands.len() + self.in_flight.iter().filter(|(_, o, _)| matches!(o, Origin::Command(_))).count();
        let mut dropped_ids: Vec<u64> = self.in_flight.iter().filter_map(|(_, o, _)| if let Origin::Command(Some(id)) = o { Some(*id) } else { None }).collect();
        dropped_ids.extend(self.commands.iter().filter_map(|(_, id)| *id));
        self.in_flight.clear();
        self.in_flight_bytes = 0;
        self.commands.clear();
        self.jog = None;
        let mut job_ended = None;
        if let Some(job) = &mut self.job {
            if job.phase.is_active() {
                let (phase, msg) = match job.phase {
                    JobPhase::Stopping => (JobPhase::Stopped, format!("Stopped at line {}.", job.last_source_line)),
                    _ => (JobPhase::Failed, format!("Job aborted at line {}: {reason}.", job.last_source_line)),
                };
                job.end(phase, Some(msg), now);
                job_ended = Some(phase);
            }
        }
        FlushResult { dropped_commands: dropped, dropped_ids, job_ended }
    }

    // ----- job control ------------------------------------------------------

    pub fn pause_job(&mut self, now: Instant) -> bool {
        match &mut self.job {
            Some(j) if matches!(j.phase, JobPhase::Running | JobPhase::Starting) => {
                j.phase = JobPhase::Paused;
                j.paused_at = Some(now);
                true
            }
            _ => false,
        }
    }

    pub fn resume_job(&mut self, now: Instant) -> bool {
        match &mut self.job {
            Some(j) if matches!(j.phase, JobPhase::Paused | JobPhase::PausedOnError) => {
                if let Some(p) = j.paused_at.take() {
                    j.paused_total += now.saturating_duration_since(p);
                }
                j.phase = if j.acked >= j.lines.len() && j.next >= j.lines.len() && j.postlude.is_empty() && j.mode == JobMode::Run {
                    j.finishing_since = Some(now);
                    JobPhase::Finishing
                } else {
                    JobPhase::Running
                };
                true
            }
            _ => false,
        }
    }

    /// The guided tool change finished: continue with the M6 line (without M6).
    pub fn tool_change_done(&mut self, now: Instant) -> bool {
        match &mut self.job {
            Some(j) if j.phase == JobPhase::ToolChange => {
                if let Some(p) = j.paused_at.take() {
                    j.paused_total += now.saturating_duration_since(p);
                }
                j.tool_change_cleared = Some(j.next);
                j.pending_tool_change = None;
                j.phase = JobPhase::Running;
                true
            }
            _ => false,
        }
    }

    /// Begin stopping: the caller sends a feed hold now and a reset once the
    /// machine has stopped (see `Link`).
    pub fn request_stop(&mut self, now: Instant) -> bool {
        match &mut self.job {
            Some(j) if j.phase.is_active() && j.phase != JobPhase::Stopping => {
                j.phase = JobPhase::Stopping;
                j.stop_requested_at = Some(now);
                self.commands.clear();
                true
            }
            _ => false,
        }
    }

    /// Called with each status report. Completes a run once the machine is
    /// idle after everything was acknowledged.
    pub fn on_status_idle(&mut self, report_time: Instant) -> bool {
        if let Some(j) = &mut self.job {
            if j.phase == JobPhase::Finishing && j.finishing_since.is_some_and(|f| report_time > f) {
                j.end(JobPhase::Completed, Some("Job finished.".into()), report_time);
                return true;
            }
        }
        false
    }

    // ----- jogging ----------------------------------------------------------

    /// `dir` is a direction per axis (any length); `accel` is the smallest
    /// acceleration of the moving axes in mm/s².
    pub fn jog_start(&mut self, dir: [f64; 3], feed: f64, accel: f64, now: Instant) {
        let norm = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if norm < 1e-9 || feed <= 0.0 {
            return;
        }
        let v = feed / 60.0;
        // Long enough to cover the stopping distance (keeps motion smooth),
        // at least 0.1 s of travel.
        let len = (v * JOG_CHUNK_SECS).max(v * v / (2.0 * accel.max(1.0)) / (JOG_MAX_IN_FLIGHT as f64 - 1.0)).max(0.05);
        let chunk = dir.map(|d| d / norm * len);
        self.jog = Some(JogRun { chunk, feed, last_beat: now, stopping: false });
    }

    pub fn jog_heartbeat(&mut self, now: Instant) {
        if let Some(j) = &mut self.jog {
            j.last_beat = now;
        }
    }

    pub fn jog_stop(&mut self) {
        if let Some(j) = &mut self.jog {
            j.stopping = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize, text: &str) -> Vec<PreparedLine> {
        (0..n).map(|i| PreparedLine { source_line: i as u32 + 1, text: text.to_string(), tool_change: None }).collect()
    }

    fn drain(e: &mut Engine, now: Instant) -> Vec<Outgoing> {
        let mut out = Vec::new();
        while let Some(o) = e.poll(now) {
            out.push(o);
        }
        out
    }

    #[test]
    fn character_counting_never_exceeds_capacity() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.start_job(Job::new("j".into(), lines(100, "G1X10.000Y10.000F1000"), JobMode::Run, t)); // 21 + 1 bytes
        let sent = drain(&mut e, t);
        assert_eq!(sent.len(), 5); // 5 × 22 = 110 ≤ 127, 6 × 22 = 132 > 127
        assert!(e.in_flight_bytes() <= 127);
        e.on_ack(None, t);
        assert_eq!(drain(&mut e, t).len(), 1);
    }

    #[test]
    fn send_response_mode_sends_one_at_a_time() {
        let t = Instant::now();
        let mut e = Engine::new(false, 128);
        e.start_job(Job::new("j".into(), lines(3, "G0X1"), JobMode::Run, t));
        assert_eq!(drain(&mut e, t).len(), 1);
        e.on_ack(None, t);
        assert_eq!(drain(&mut e, t).len(), 1);
    }

    #[test]
    fn system_commands_are_sent_alone() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.queue_command("G0X1".into());
        e.queue_command("$110=500".into());
        e.queue_command("G0X2".into());
        let first = drain(&mut e, t);
        assert_eq!(first.len(), 1, "$ command waits for the buffer to empty");
        e.on_ack(None, t);
        assert_eq!(drain(&mut e, t), vec![Outgoing::Line { text: "$110=500".into(), origin: Origin::Command(None) }]);
        e.on_ack(None, t);
        assert_eq!(drain(&mut e, t).len(), 1);
    }

    #[test]
    fn job_runs_to_completion_after_idle() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.start_job(Job::new("j".into(), lines(3, "G0X1"), JobMode::Run, t));
        assert_eq!(drain(&mut e, t).len(), 3);
        for _ in 0..3 {
            assert_eq!(e.on_ack(None, t), AckEvent::Job);
        }
        drain(&mut e, t);
        assert_eq!(e.job.as_ref().unwrap().phase, JobPhase::Finishing);
        assert!(!e.on_status_idle(t), "stale report must not complete the job");
        assert!(e.on_status_idle(t + Duration::from_millis(10)));
        assert_eq!(e.job.as_ref().unwrap().phase, JobPhase::Completed);
    }

    #[test]
    fn error_pauses_run_and_records_check() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.start_job(Job::new("j".into(), lines(5, "G0X1"), JobMode::Run, t));
        drain(&mut e, t);
        assert!(matches!(e.on_ack(Some((Some(20), "20".into())), t), AckEvent::JobErrorPaused(ref err) if err.source_line == 1));
        assert_eq!(e.job.as_ref().unwrap().phase, JobPhase::PausedOnError);
        assert!(drain(&mut e, t).is_empty());
        assert!(e.resume_job(t));
        let mut c = Engine::new(true, 128);
        c.start_job(Job::new("c".into(), lines(3, "G0X1"), JobMode::Check, t));
        assert_eq!(drain(&mut c, t), vec![Outgoing::Line { text: "$C".into(), origin: Origin::JobControl }]);
        c.on_ack(None, t);
        assert_eq!(drain(&mut c, t).len(), 3);
        assert!(matches!(c.on_ack(Some((Some(22), "22".into())), t), AckEvent::JobErrorRecorded(_)));
        c.on_ack(None, t);
        c.on_ack(None, t);
        assert_eq!(drain(&mut c, t), vec![Outgoing::Line { text: "$C".into(), origin: Origin::JobControl }]);
        c.on_ack(None, t);
        drain(&mut c, t);
        let p = c.job.as_ref().unwrap().progress(t);
        assert_eq!(p.phase, JobPhase::Completed);
        assert_eq!(p.error_count, 1);
    }

    #[test]
    fn flush_aborts_job_and_drops_commands() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.start_job(Job::new("j".into(), lines(50, "G1X1F100"), JobMode::Run, t));
        drain(&mut e, t);
        e.on_ack(None, t);
        let r = e.flush("connection lost", t);
        assert_eq!(r.job_ended, Some(JobPhase::Failed));
        assert!(e.job.as_ref().unwrap().message.as_ref().unwrap().contains("line 1"));
        assert!(drain(&mut e, t).is_empty());
        // stop → reset → flush counts as Stopped
        let mut s = Engine::new(true, 128);
        s.start_job(Job::new("j".into(), lines(50, "G1X1F100"), JobMode::Run, t));
        drain(&mut s, t);
        assert!(s.request_stop(t));
        assert!(drain(&mut s, t).is_empty());
        assert_eq!(s.flush("reset", t).job_ended, Some(JobPhase::Stopped));
    }

    #[test]
    fn commands_wait_during_a_running_job_but_run_while_paused() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.start_job(Job::new("j".into(), lines(2, "G0X1"), JobMode::Run, t));
        drain(&mut e, t);
        e.queue_command("$G".into());
        assert!(drain(&mut e, t).is_empty());
        e.pause_job(t);
        e.on_ack(None, t);
        e.on_ack(None, t);
        assert_eq!(drain(&mut e, t), vec![Outgoing::Line { text: "$G".into(), origin: Origin::Command(None) }]);
    }

    #[test]
    fn jog_streams_chunks_and_cancels_only_after_acks() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.jog_start([1.0, 0.0, 0.0], 3000.0, 500.0, t);
        let out = drain(&mut e, t);
        assert_eq!(out.len(), JOG_MAX_IN_FLIGHT);
        let Outgoing::Line { text, .. } = &out[0] else { panic!() };
        assert!(text.starts_with("$J=G91G21X5.000F3000"), "{text}");
        e.jog_stop();
        assert!(drain(&mut e, t).is_empty(), "no cancel while chunks are still unacknowledged");
        for _ in 0..JOG_MAX_IN_FLIGHT {
            e.on_ack(None, t);
        }
        assert_eq!(drain(&mut e, t), vec![Outgoing::Realtime(0x85)]);
        assert!(!e.jogging());
    }

    #[test]
    fn jog_watchdog_stops_without_heartbeat() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.jog_start([0.0, -1.0, 0.0], 1000.0, 200.0, t);
        drain(&mut e, t);
        for _ in 0..JOG_MAX_IN_FLIGHT {
            e.on_ack(None, t);
        }
        e.jog_heartbeat(t + Duration::from_millis(200));
        assert!(matches!(e.poll(t + Duration::from_millis(300)), Some(Outgoing::Line { .. })));
        e.on_ack(None, t);
        let late = t + Duration::from_millis(200) + JOG_HEARTBEAT_TIMEOUT + Duration::from_millis(10);
        assert_eq!(e.poll(late), Some(Outgoing::Realtime(0x85)));
    }

    #[test]
    fn jog_error_stops_jogging() {
        let t = Instant::now();
        let mut e = Engine::new(true, 128);
        e.jog_start([1.0, 0.0, 0.0], 1000.0, 200.0, t);
        drain(&mut e, t);
        assert_eq!(e.on_ack(Some((Some(15), "15".into())), t), AckEvent::Jog { error: Some(15) });
        e.on_ack(None, t);
        e.on_ack(None, t);
        assert_eq!(drain(&mut e, t), vec![Outgoing::Realtime(0x85)]);
    }
}
