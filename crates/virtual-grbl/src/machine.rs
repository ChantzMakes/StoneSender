//! The emulator core. See crate docs and `AGENTS.md` for the fidelity notes.

// Per-axis loops index several parallel arrays (target, start, unit, offsets);
// explicit indices read more clearly than zipped iterators here.
#![allow(clippy::needless_range_loop)]

use crate::gcode::{clean_line, err, tokenize};
use crate::settings::{default_settings, format_value, legacy_comment};
use grbl_core::profile::MachineProfile;
use grbl_core::realtime as rt;
use std::collections::{BTreeMap, VecDeque};

const N: usize = 4;
type Pos = [f64; N];
const MM_PER_INCH: f64 = 25.4;
const EPS: f64 = 1e-9;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    /// Stock GRBL 1.1h (Arduino Uno): 128-byte RX, 15 usable planner blocks.
    Grbl11,
    /// GRBL 0.9j: old status format and text errors. Used to test detection.
    Grbl09,
    /// grblHAL: larger buffers, longer lines, M6/M7 accepted.
    GrblHal,
}

impl Flavor {
    pub fn banner(self) -> &'static str {
        match self {
            Flavor::Grbl11 => "Grbl 1.1h ['$' for help]",
            Flavor::Grbl09 => "Grbl 0.9j ['$' for help]",
            Flavor::GrblHal => "GrblHAL 1.1f ['$' or '$HELP' for help]",
        }
    }
    pub fn default_rx_buffer(self) -> usize {
        match self {
            Flavor::GrblHal => 1024,
            _ => 128,
        }
    }
    pub fn default_planner_blocks(self) -> usize {
        match self {
            Flavor::Grbl11 => 15,
            Flavor::Grbl09 => 17,
            Flavor::GrblHal => 35,
        }
    }
    fn max_line(self) -> usize {
        match self {
            Flavor::GrblHal => 255,
            _ => 79,
        }
    }
    fn legacy(self) -> bool {
        self == Flavor::Grbl09
    }
}

/// An axis-aligned block the probe can touch (stock, touch plate, spoilboard).
/// `tilt` adds `tilt[0]*(x-min.x) + tilt[1]*(y-min.y)` to the top surface so
/// height-map probing has something to find.
#[derive(Clone, Debug, PartialEq)]
pub struct ProbeBox {
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub tilt: [f64; 2],
}

impl ProbeBox {
    fn contains(&self, p: &Pos) -> bool {
        let top = self.max[2] + self.tilt[0] * (p[0] - self.min[0]) + self.tilt[1] * (p[1] - self.min[1]);
        p[0] >= self.min[0] && p[0] <= self.max[0] && p[1] >= self.min[1] && p[1] <= self.max[1] && p[2] >= self.min[2] && p[2] <= top
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProbeSurface {
    pub boxes: Vec<ProbeBox>,
}

#[derive(Clone, Debug)]
pub struct VirtualConfig {
    pub flavor: Flavor,
    pub settings: BTreeMap<u16, f64>,
    /// 3 or 4 (A axis)
    pub axes: usize,
    pub rx_buffer_size: usize,
    pub planner_blocks: usize,
    pub probe: ProbeSurface,
    /// Seconds before the welcome banner (Arduino bootloader delay).
    pub boot_delay: f64,
    /// Simulation speed multiplier used by the threaded wrapper.
    pub time_scale: f64,
}

impl VirtualConfig {
    pub fn new(flavor: Flavor) -> Self {
        let axes = 3;
        VirtualConfig {
            flavor,
            settings: default_settings(axes),
            axes,
            rx_buffer_size: flavor.default_rx_buffer(),
            planner_blocks: flavor.default_planner_blocks(),
            probe: ProbeSurface {
                boxes: vec![ProbeBox { min: [-200.0, -200.0, -200.0], max: [0.0, 0.0, -150.0], tilt: [0.0, 0.0] }],
            },
            boot_delay: 0.0,
            time_scale: 1.0,
        }
    }

    /// Configure the emulator to match a machine profile. The probe surface is
    /// the spoilboard plus 25 mm of stock across the whole bed.
    pub fn from_profile(p: &MachineProfile, flavor: Flavor) -> Self {
        let axes = if p.has_rotary() { 4 } else { 3 };
        let mut settings = default_settings(axes);
        settings.extend(p.to_grbl_settings());
        let e = p.geometry.envelope;
        let stock_top = -e.z + 25.0_f64.min(e.z * 0.5);
        VirtualConfig {
            flavor,
            settings,
            axes,
            rx_buffer_size: flavor.default_rx_buffer(),
            planner_blocks: flavor.default_planner_blocks(),
            probe: ProbeSurface {
                boxes: vec![ProbeBox { min: [-e.x, -e.y, -e.z - 10.0], max: [0.0, 0.0, stock_top], tilt: [0.0, 0.0] }],
            },
            boot_delay: 0.3,
            time_scale: 1.0,
        }
    }
}

/// Faults that tests (and the developer panel) can inject.
#[derive(Clone, Debug, PartialEq)]
pub enum Fault {
    /// The port vanishes (USB unplugged). Reads return an error.
    Disconnect,
    /// Raise `ALARM:n` immediately (1 = hard limit, 2 = soft limit are critical).
    Alarm(u16),
    /// The next G-code line answers `error:n` instead of executing.
    ErrorOnNextLine(u16),
    /// Swallow the next `ok` (sender must not deadlock silently).
    DropNextOk,
    /// Stop reading the RX buffer for this many seconds.
    Stall(f64),
    /// Force the probe pin state (None = use the virtual surface).
    ProbePin(Option<bool>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub rx_overflows: u64,
    pub max_rx_used: usize,
    pub max_planner_used: usize,
    pub lines_processed: u64,
    pub oks_sent: u64,
    pub errors_sent: u64,
    pub alarms_sent: u64,
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Idle,
    Run,
    /// 0 = complete, 1 = decelerating
    Hold(u8),
    Jog,
    Alarm,
    Check,
    Home,
    Sleep,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum BlockKind {
    Feed,
    Rapid,
    Jog,
    Homing,
    Probe,
}

#[derive(Clone, Debug)]
struct Block {
    kind: BlockKind,
    start: Pos,
    target: Pos,
    unit: Pos,
    len: f64,
    /// mm/min requested (ignored for rapids)
    feed: f64,
    /// mm/s² along the path, limited by every axis
    accel: f64,
    /// mm/s along the path, limited by axis max rates (before overrides)
    axis_limit: f64,
    /// Max entry speed from the junction-deviation model (mm/s)
    junction_max: f64,
    /// Planned entry speed (backward pass)
    entry: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum MotionMode {
    Rapid,
    Linear,
    Cw,
    Ccw,
    /// 2..=5 for G38.2..G38.5
    Probe(u8),
    None,
}

#[derive(Clone, Debug)]
struct Modal {
    motion: MotionMode,
    /// 0 = G17 (XY), 1 = G18 (ZX), 2 = G19 (YZ)
    plane: u8,
    inches: bool,
    absolute: bool,
    inverse_time: bool,
    wcs: usize,
    spindle: i8,
    flood: bool,
    mist: bool,
    tool: u32,
    feed: f64,
    speed: f64,
}

impl Default for Modal {
    fn default() -> Self {
        Modal {
            motion: MotionMode::Rapid,
            plane: 0,
            inches: false,
            absolute: true,
            inverse_time: false,
            wcs: 0,
            spindle: 0,
            flood: false,
            mist: false,
            tool: 0,
            feed: 0.0,
            speed: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
enum Op {
    /// Wait until all motion has finished.
    Sync,
    Move(Block),
    Spindle { dir: i8, speed: f64 },
    Coolant { flood: bool, mist: bool },
    Dwell(f64),
    Probe { target: Pos, feed: f64, toward: bool, error_on_fail: bool },
    Pause,
    ProgramEnd,
    HomeFinish,
}

#[derive(Clone, Debug)]
struct ProbeRun {
    toward: bool,
    error_on_fail: bool,
    result: Option<bool>,
}

struct Exec {
    block: Block,
    traveled: f64,
}

// ---------------------------------------------------------------------------
// The emulator
// ---------------------------------------------------------------------------

pub struct VirtualGrbl {
    cfg: VirtualConfig,
    settings: BTreeMap<u16, f64>,
    clock: f64,
    booted: bool,
    pub(crate) disconnected: bool,

    rx: VecDeque<u8>,
    out: Vec<u8>,
    stats: Stats,

    state: State,
    critical: bool,
    homed: bool,

    pos: Pos,
    gc_pos: Pos,
    modal: Modal,
    wcs: [Pos; 6],
    g28: Pos,
    g30: Pos,
    g92: Pos,
    tlo: f64,
    prb: (Pos, bool),
    startup_lines: [String; 2],

    planner: VecDeque<Block>,
    current: Option<Exec>,
    v: f64,
    cur_exit: f64,
    replan_needed: bool,
    last_unit: Option<Pos>,
    jog_cancel: bool,

    ops: VecDeque<Op>,
    ack_after_ops: bool,
    dwell_left: Option<f64>,
    probe_run: Option<ProbeRun>,

    act_spindle: (i8, f64),
    act_flood: bool,
    act_mist: bool,
    feed_ovr: u16,
    rapid_ovr: u16,
    spindle_ovr: u16,

    status_requested: bool,
    wco_counter: u8,
    ovr_counter: u8,

    forced_error: Option<u16>,
    drop_ok: u32,
    stall_until: f64,
    forced_probe: Option<bool>,
}

impl VirtualGrbl {
    pub fn new(cfg: VirtualConfig) -> Self {
        let settings = cfg.settings.clone();
        let mut g = VirtualGrbl {
            settings,
            clock: 0.0,
            booted: false,
            disconnected: false,
            rx: VecDeque::with_capacity(cfg.rx_buffer_size),
            out: Vec::new(),
            stats: Stats::default(),
            state: State::Idle,
            critical: false,
            homed: false,
            pos: [0.0; N],
            gc_pos: [0.0; N],
            modal: Modal::default(),
            wcs: [[0.0; N]; 6],
            g28: [0.0; N],
            g30: [0.0; N],
            g92: [0.0; N],
            tlo: 0.0,
            prb: ([0.0; N], false),
            startup_lines: [String::new(), String::new()],
            planner: VecDeque::new(),
            current: None,
            v: 0.0,
            cur_exit: 0.0,
            replan_needed: false,
            last_unit: None,
            jog_cancel: false,
            ops: VecDeque::new(),
            ack_after_ops: false,
            dwell_left: None,
            probe_run: None,
            act_spindle: (0, 0.0),
            act_flood: false,
            act_mist: false,
            feed_ovr: 100,
            rapid_ovr: 100,
            spindle_ovr: 100,
            status_requested: false,
            wco_counter: 0,
            ovr_counter: 0,
            forced_error: None,
            drop_ok: 0,
            stall_until: 0.0,
            forced_probe: None,
            cfg,
        };
        if g.cfg.boot_delay <= 0.0 {
            g.boot();
        }
        g
    }

    // ----- public API -------------------------------------------------------

    /// Bytes arriving from the host. Real-time commands act immediately; the
    /// rest go into the RX buffer (dropped and counted if it overflows, like
    /// the real serial ISR).
    pub fn receive(&mut self, bytes: &[u8]) {
        if !self.booted || self.disconnected {
            return;
        }
        let legacy = self.cfg.flavor.legacy();
        for &b in bytes {
            match b {
                rt::STATUS_REPORT => self.status_requested = true,
                rt::FEED_HOLD => self.feed_hold(),
                rt::CYCLE_START => self.cycle_start(),
                rt::SOFT_RESET => self.soft_reset(),
                _ if b >= 0x80 => {
                    if !legacy {
                        self.realtime_ext(b)
                    }
                }
                _ => {
                    if self.rx.len() >= self.cfg.rx_buffer_size {
                        self.stats.rx_overflows += 1;
                    } else {
                        self.rx.push_back(b);
                        self.stats.max_rx_used = self.stats.max_rx_used.max(self.rx.len());
                    }
                }
            }
        }
    }

    /// Advance simulated time by `dt` seconds.
    pub fn step(&mut self, dt: f64) {
        self.clock += dt;
        if !self.booted {
            if self.clock >= self.cfg.boot_delay {
                self.boot();
            } else {
                return;
            }
        }
        self.process_input();
        let mut remaining = dt;
        while remaining > EPS {
            let h = remaining.min(0.001);
            self.advance(h);
            self.process_input();
            remaining -= h;
        }
        if self.status_requested {
            self.status_requested = false;
            let r = self.status_report();
            self.emit(&r);
        }
    }

    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }

    pub fn inject(&mut self, fault: Fault) {
        match fault {
            Fault::Disconnect => self.disconnected = true,
            Fault::Alarm(code) => self.alarm(code),
            Fault::ErrorOnNextLine(code) => self.forced_error = Some(code),
            Fault::DropNextOk => self.drop_ok += 1,
            Fault::Stall(secs) => self.stall_until = self.clock + secs,
            Fault::ProbePin(v) => self.forced_probe = v,
        }
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }
    pub fn machine_pos(&self) -> [f64; 4] {
        self.pos
    }
    pub fn work_pos(&self) -> [f64; 4] {
        let wco = self.wco();
        [0, 1, 2, 3].map(|i| self.pos[i] - wco[i])
    }
    pub fn state_name(&self) -> String {
        self.state_str()
    }
    pub fn setting(&self, id: u16) -> Option<f64> {
        self.settings.get(&id).copied()
    }
    pub fn rx_used(&self) -> usize {
        self.rx.len()
    }
    pub fn planner_used(&self) -> usize {
        self.planner.len() + usize::from(self.current.is_some())
    }
    pub fn is_disconnected(&self) -> bool {
        self.disconnected
    }
    pub fn time_scale(&self) -> f64 {
        self.cfg.time_scale
    }

    // ----- output helpers ---------------------------------------------------

    fn emit(&mut self, line: &str) {
        self.out.extend_from_slice(line.as_bytes());
        self.out.extend_from_slice(b"\r\n");
    }

    fn send_ok(&mut self) {
        if self.drop_ok > 0 {
            self.drop_ok -= 1;
            return;
        }
        self.stats.oks_sent += 1;
        self.emit("ok");
    }

    fn send_error(&mut self, code: u16) {
        self.stats.errors_sent += 1;
        let line = if self.cfg.flavor.legacy() {
            format!("error: {}", legacy_error_text(code))
        } else {
            format!("error:{code}")
        };
        self.emit(&line);
    }

    fn msg(&mut self, text: &str) {
        let line = if self.cfg.flavor.legacy() { format!("[{text}]") } else { format!("[MSG:{text}]") };
        self.emit(&line);
    }

    fn boot(&mut self) {
        self.booted = true;
        self.emit("");
        let banner = self.cfg.flavor.banner();
        self.emit(banner);
        if self.flag(22) {
            self.state = State::Alarm;
            self.msg("'$H'|'$X' to unlock");
        } else {
            self.run_startup_lines();
        }
    }

    fn flag(&self, id: u16) -> bool {
        self.settings.get(&id).copied().unwrap_or(0.0) != 0.0
    }
    fn s(&self, id: u16) -> f64 {
        self.settings.get(&id).copied().unwrap_or(0.0)
    }

    // ----- real-time commands ----------------------------------------------

    fn feed_hold(&mut self) {
        match self.state {
            State::Run => self.state = State::Hold(1),
            State::Idle => self.state = State::Hold(0),
            State::Jog => self.jog_cancel = true,
            _ => {}
        }
    }

    fn cycle_start(&mut self) {
        if let State::Hold(0) = self.state {
            self.state = if self.current.is_some() || !self.planner.is_empty() { State::Run } else { State::Idle };
            self.replan_needed = true;
        }
    }

    fn realtime_ext(&mut self, b: u8) {
        let before = (self.feed_ovr, self.rapid_ovr, self.spindle_ovr);
        let clamp = |v: i32| v.clamp(10, 200) as u16;
        match b {
            rt::JOG_CANCEL => {
                if self.state == State::Jog {
                    self.jog_cancel = true;
                }
            }
            rt::FEED_OVR_RESET => self.feed_ovr = 100,
            rt::FEED_OVR_COARSE_PLUS => self.feed_ovr = clamp(self.feed_ovr as i32 + 10),
            rt::FEED_OVR_COARSE_MINUS => self.feed_ovr = clamp(self.feed_ovr as i32 - 10),
            rt::FEED_OVR_FINE_PLUS => self.feed_ovr = clamp(self.feed_ovr as i32 + 1),
            rt::FEED_OVR_FINE_MINUS => self.feed_ovr = clamp(self.feed_ovr as i32 - 1),
            rt::RAPID_OVR_RESET => self.rapid_ovr = 100,
            rt::RAPID_OVR_MEDIUM => self.rapid_ovr = 50,
            rt::RAPID_OVR_LOW => self.rapid_ovr = 25,
            rt::SPINDLE_OVR_RESET => self.spindle_ovr = 100,
            rt::SPINDLE_OVR_COARSE_PLUS => self.spindle_ovr = clamp(self.spindle_ovr as i32 + 10),
            rt::SPINDLE_OVR_COARSE_MINUS => self.spindle_ovr = clamp(self.spindle_ovr as i32 - 10),
            rt::SPINDLE_OVR_FINE_PLUS => self.spindle_ovr = clamp(self.spindle_ovr as i32 + 1),
            rt::SPINDLE_OVR_FINE_MINUS => self.spindle_ovr = clamp(self.spindle_ovr as i32 - 1),
            rt::SPINDLE_STOP_TOGGLE => {
                if self.state == State::Hold(0) {
                    self.act_spindle.0 = if self.act_spindle.0 == 0 { self.modal.spindle } else { 0 };
                    self.ovr_counter = 0;
                }
            }
            rt::FLOOD_TOGGLE => {
                if matches!(self.state, State::Idle | State::Run | State::Hold(_)) {
                    self.act_flood = !self.act_flood;
                    self.modal.flood = self.act_flood;
                    self.ovr_counter = 0;
                }
            }
            rt::MIST_TOGGLE
                if matches!(self.state, State::Idle | State::Run | State::Hold(_)) && self.cfg.flavor == Flavor::GrblHal => {
                    self.act_mist = !self.act_mist;
                    self.modal.mist = self.act_mist;
                    self.ovr_counter = 0;
                }
            _ => {}
        }
        if before != (self.feed_ovr, self.rapid_ovr, self.spindle_ovr) {
            self.ovr_counter = 0;
            self.replan_needed = true;
        }
    }

    fn soft_reset(&mut self) {
        // GRBL only loses position (ALARM:3) if steps were being generated;
        // a reset after a completed feed hold (Hold:0) keeps it.
        let moving = match self.state {
            State::Home => true,
            State::Hold(0) => false,
            State::Run | State::Jog | State::Hold(_) => self.current.is_some() || !self.planner.is_empty() || self.v > EPS,
            _ => false,
        };
        let was_alarm = self.state == State::Alarm;
        let was_sleep = self.state == State::Sleep;
        self.flush_motion();
        self.rx.clear();
        self.ops.clear();
        self.ack_after_ops = false;
        self.dwell_left = None;
        self.probe_run = None;
        self.critical = false;
        self.jog_cancel = false;
        let wcs = self.modal.wcs;
        self.modal = Modal { wcs, ..Modal::default() };
        self.g92 = [0.0; N];
        self.tlo = 0.0;
        self.act_spindle = (0, 0.0);
        self.act_flood = false;
        self.act_mist = false;
        self.feed_ovr = 100;
        self.rapid_ovr = 100;
        self.spindle_ovr = 100;
        self.wco_counter = 0;
        self.ovr_counter = 0;
        if moving {
            self.homed = false;
            self.emit_alarm(3);
        }
        self.state = if moving || was_alarm || (was_sleep && self.flag(22)) { State::Alarm } else { State::Idle };
        self.emit("");
        let banner = self.cfg.flavor.banner();
        self.emit(banner);
        if self.state == State::Alarm {
            self.msg("'$H'|'$X' to unlock");
        } else {
            self.run_startup_lines();
        }
    }

    fn run_startup_lines(&mut self) {
        for i in 0..2 {
            let line = self.startup_lines[i].clone();
            if line.is_empty() {
                continue;
            }
            let result = match tokenize(&clean_line(line.as_bytes())) {
                Ok(words) => self.execute_gcode(words, false).map(|ops| {
                    self.ops.extend(ops);
                }),
                Err(e) => Err(e),
            };
            match result {
                Ok(()) => self.emit(&format!(">{line}:ok")),
                Err(code) => self.emit(&format!(">{line}:error:{code}")),
            }
        }
    }

    fn flush_motion(&mut self) {
        self.planner.clear();
        self.current = None;
        self.v = 0.0;
        self.cur_exit = 0.0;
        self.last_unit = None;
        self.gc_pos = self.pos;
    }

    fn emit_alarm(&mut self, code: u16) {
        self.stats.alarms_sent += 1;
        let line = if self.cfg.flavor.legacy() {
            format!("ALARM: {}", legacy_alarm_text(code))
        } else {
            format!("ALARM:{code}")
        };
        self.emit(&line);
    }

    fn alarm(&mut self, code: u16) {
        self.flush_motion();
        self.ops.clear();
        self.ack_after_ops = false;
        self.dwell_left = None;
        self.probe_run = None;
        self.act_spindle = (0, 0.0);
        self.state = State::Alarm;
        self.emit_alarm(code);
        if matches!(code, 1 | 2 | 10) {
            self.critical = true;
            self.homed = false;
            self.msg("Reset to continue");
        }
    }

    // ----- input processing ---------------------------------------------------

    fn process_input(&mut self) {
        loop {
            if self.critical || self.clock < self.stall_until {
                return;
            }
            if !self.ops.is_empty() || self.ack_after_ops {
                if !self.run_ops() {
                    return;
                }
                if self.ack_after_ops {
                    self.ack_after_ops = false;
                    self.send_ok();
                }
                continue;
            }
            let Some(line) = self.take_line() else { return };
            self.stats.lines_processed += 1;
            self.execute_line(&line);
        }
    }

    fn take_line(&mut self) -> Option<Vec<u8>> {
        let idx = self.rx.iter().position(|&b| b == b'\n' || b == b'\r')?;
        let line: Vec<u8> = self.rx.drain(..=idx).collect();
        Some(line[..line.len() - 1].to_vec())
    }

    fn execute_line(&mut self, raw: &[u8]) {
        let line = clean_line(raw);
        if line.is_empty() {
            self.send_ok();
            return;
        }
        if line.len() > self.cfg.flavor.max_line() {
            self.send_error(err::OVERFLOW);
            return;
        }
        if let Some(code) = self.forced_error.take() {
            self.send_error(code);
            return;
        }
        if let Some(cmd) = line.strip_prefix('$') {
            match self.system_command(cmd, raw) {
                Ok(true) => self.send_ok(),
                Ok(false) => {}
                Err(code) => self.send_error(code),
            }
            return;
        }
        if matches!(self.state, State::Alarm | State::Jog | State::Sleep) {
            self.send_error(err::SYSTEM_GC_LOCK);
            return;
        }
        let words = match tokenize(&line) {
            Ok(w) => w,
            Err(e) => {
                self.send_error(e);
                return;
            }
        };
        match self.execute_gcode(words, false) {
            Ok(ops) => {
                // Check mode returns no ops, so it is acknowledged immediately.
                if ops.is_empty() {
                    self.send_ok();
                } else {
                    self.ops.extend(ops);
                    self.ack_after_ops = true;
                }
            }
            Err(code) => {
                if code != 0 {
                    self.send_error(code);
                }
            }
        }
    }

    /// Returns Ok(true) to send `ok`, Ok(false) if the command already
    /// handled its acknowledgement (e.g. queued ops).
    fn system_command(&mut self, cmd: &str, raw: &[u8]) -> Result<bool, u16> {
        let legacy = self.cfg.flavor.legacy();
        let idle_or_alarm = matches!(self.state, State::Idle | State::Alarm);
        match cmd {
            "" => {
                let h = if legacy {
                    "$$ (view Grbl settings)\r\n$# (view # parameters)\r\n$G (view parser state)\r\n$I (view build info)\r\n$N (view startup blocks)\r\n$x=value (save Grbl setting)\r\n$Nx=line (save startup block)\r\n$C (check gcode mode)\r\n$X (kill alarm lock)\r\n$H (run homing cycle)\r\n~ (cycle start)\r\n! (feed hold)\r\n? (current status)\r\nctrl-x (reset Grbl)"
                } else {
                    "[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]"
                };
                self.emit(h);
                Ok(true)
            }
            "$" => {
                if matches!(self.state, State::Run | State::Hold(_) | State::Jog) {
                    return Err(err::IDLE_ERROR);
                }
                let entries: Vec<(u16, f64)> = self.settings.iter().map(|(k, v)| (*k, *v)).collect();
                for (id, v) in entries {
                    let line = if legacy {
                        format!("${id}={} ({})", format_value(id, v), legacy_comment(id))
                    } else {
                        format!("${id}={}", format_value(id, v))
                    };
                    self.emit(&line);
                }
                Ok(true)
            }
            "#" => {
                if !idle_or_alarm && self.state != State::Check {
                    return Err(err::IDLE_ERROR);
                }
                let axes = self.cfg.axes;
                let names = ["G54", "G55", "G56", "G57", "G58", "G59"];
                for (i, n) in names.iter().enumerate() {
                    let v = fmt_pos(&self.wcs[i], axes, false);
                    self.emit(&format!("[{n}:{v}]"));
                }
                let g28 = fmt_pos(&self.g28, axes, false);
                let g30 = fmt_pos(&self.g30, axes, false);
                let g92 = fmt_pos(&self.g92, axes, false);
                self.emit(&format!("[G28:{g28}]"));
                self.emit(&format!("[G30:{g30}]"));
                self.emit(&format!("[G92:{g92}]"));
                self.emit(&format!("[TLO:{:.3}]", self.tlo));
                let prb = fmt_pos(&self.prb.0, axes, false);
                self.emit(&format!("[PRB:{prb}:{}]", u8::from(self.prb.1)));
                Ok(true)
            }
            "G" => {
                let words = self.parser_state_words();
                let line = if legacy { format!("[{words}]") } else { format!("[GC:{words}]") };
                self.emit(&line);
                Ok(true)
            }
            "I" => {
                if !idle_or_alarm {
                    return Err(err::IDLE_ERROR);
                }
                match self.cfg.flavor {
                    Flavor::Grbl09 => self.emit("[0.9j.20160303:]"),
                    Flavor::Grbl11 => {
                        self.emit("[VER:1.1h.20190830:]");
                        let line = format!("[OPT:V,{},{}]", self.cfg.planner_blocks, self.cfg.rx_buffer_size);
                        self.emit(&line);
                    }
                    Flavor::GrblHal => {
                        self.emit("[VER:1.1f.20240101:]");
                        let line = format!("[OPT:VNMSL,{},{},{},0]", self.cfg.planner_blocks, self.cfg.rx_buffer_size, self.cfg.axes);
                        self.emit(&line);
                        self.emit("[FIRMWARE:grblHAL]");
                        self.emit("[DRIVER:Virtual]");
                    }
                }
                Ok(true)
            }
            "N" => {
                for i in 0..2 {
                    let l = format!("$N{i}={}", self.startup_lines[i]);
                    self.emit(&l);
                }
                Ok(true)
            }
            "X" => {
                if self.state == State::Alarm {
                    self.state = State::Idle;
                    self.msg("Caution: Unlocked");
                }
                Ok(true)
            }
            "H" => {
                if !self.flag(22) {
                    return Err(err::SETTING_DISABLED);
                }
                if !idle_or_alarm {
                    return Err(err::IDLE_ERROR);
                }
                self.start_homing();
                Ok(false)
            }
            "C" => {
                if self.state == State::Check {
                    self.msg("Disabled");
                    self.send_ok();
                    self.soft_reset();
                    Ok(false)
                } else if self.state != State::Idle {
                    Err(err::IDLE_ERROR)
                } else {
                    self.state = State::Check;
                    self.msg("Enabled");
                    Ok(true)
                }
            }
            "SLP" if !legacy => {
                self.flush_motion();
                self.act_spindle = (0, 0.0);
                self.act_flood = false;
                self.act_mist = false;
                self.state = State::Sleep;
                self.msg("Sleeping");
                Ok(true)
            }
            "RST=$" | "RST=#" | "RST=*" => {
                if !idle_or_alarm {
                    return Err(err::IDLE_ERROR);
                }
                if cmd != "RST=#" {
                    self.settings = default_settings(self.cfg.axes);
                }
                if cmd != "RST=$" {
                    self.wcs = [[0.0; N]; 6];
                    self.g28 = [0.0; N];
                    self.g30 = [0.0; N];
                    self.wco_counter = 0;
                }
                if cmd == "RST=*" {
                    self.startup_lines = [String::new(), String::new()];
                }
                Ok(true)
            }
            _ => {
                if let Some(jog) = cmd.strip_prefix("J=") {
                    if legacy {
                        return Err(err::INVALID_STATEMENT);
                    }
                    return self.jog(jog);
                }
                if let Some(rest) = cmd.strip_prefix('N') {
                    if let Some((idx, _)) = rest.split_once('=') {
                        let i: usize = idx.parse().map_err(|_| err::INVALID_STATEMENT)?;
                        if i > 1 {
                            return Err(err::INVALID_STATEMENT);
                        }
                        if !idle_or_alarm {
                            return Err(err::IDLE_ERROR);
                        }
                        // keep original spacing-less text after '='
                        let raw_s = String::from_utf8_lossy(raw);
                        let text = raw_s.split_once('=').map(|(_, t)| clean_line(t.as_bytes())).unwrap_or_default();
                        self.startup_lines[i] = text;
                        return Ok(true);
                    }
                }
                if let Some((id, val)) = cmd.split_once('=') {
                    let id: u16 = id.parse().map_err(|_| err::INVALID_STATEMENT)?;
                    if !self.settings.contains_key(&id) {
                        return Err(err::INVALID_STATEMENT);
                    }
                    let v: f64 = val.parse().map_err(|_| err::BAD_NUMBER_FORMAT)?;
                    if v < 0.0 {
                        return Err(err::NEGATIVE_VALUE);
                    }
                    if !idle_or_alarm {
                        return Err(err::IDLE_ERROR);
                    }
                    if id == 0 && v < 3.0 {
                        return Err(err::SETTING_STEP_PULSE_MIN);
                    }
                    if id == 20 && v != 0.0 && !self.flag(22) {
                        return Err(err::SOFT_LIMIT_ERROR);
                    }
                    if (100..=133).contains(&id) && v <= 0.0 && id < 130 {
                        return Err(err::NEGATIVE_VALUE);
                    }
                    self.settings.insert(id, v);
                    return Ok(true);
                }
                Err(err::INVALID_STATEMENT)
            }
        }
    }

    fn parser_state_words(&self) -> String {
        let m = &self.modal;
        let motion = match m.motion {
            MotionMode::Rapid => "G0".to_string(),
            MotionMode::Linear => "G1".to_string(),
            MotionMode::Cw => "G2".to_string(),
            MotionMode::Ccw => "G3".to_string(),
            MotionMode::Probe(n) => format!("G38.{n}"),
            MotionMode::None => "G80".to_string(),
        };
        let spindle = match m.spindle {
            1 => "M3",
            -1 => "M4",
            _ => "M5",
        };
        let coolant = match (m.flood, m.mist) {
            (false, false) => "M9".to_string(),
            (true, false) => "M8".to_string(),
            (false, true) => "M7".to_string(),
            (true, true) => "M7 M8".to_string(),
        };
        let feed = if m.inches { m.feed / MM_PER_INCH } else { m.feed };
        format!(
            "{motion} G{} G{} G{} G{} G{} {spindle} {coolant} T{} F{} S{}",
            54 + m.wcs,
            17 + m.plane,
            if m.inches { 20 } else { 21 },
            if m.absolute { 90 } else { 91 },
            if m.inverse_time { 93 } else { 94 },
            m.tool,
            trim_num(feed),
            trim_num(m.speed)
        )
    }

    // ----- homing & jogging ---------------------------------------------------

    fn home_position(&self) -> Pos {
        let mask = self.s(23) as u32;
        let pull = self.s(27);
        let mut p = self.pos;
        for (i, item) in p.iter_mut().enumerate().take(3) {
            let travel = self.s(130 + i as u16);
            *item = if mask & (1 << i) != 0 { -travel + pull } else { -pull };
        }
        p
    }

    fn start_homing(&mut self) {
        self.state = State::Home;
        let home = self.home_position();
        let seek = self.s(25).max(1.0);
        let mut z_target = self.pos;
        z_target[2] = home[2];
        let mut xy_target = z_target;
        xy_target[0] = home[0];
        xy_target[1] = home[1];
        let mut ops = VecDeque::new();
        if let Some(b) = self.make_block(self.pos, z_target, seek, BlockKind::Homing) {
            ops.push_back(Op::Move(b));
        }
        if let Some(b) = self.make_block(z_target, xy_target, seek, BlockKind::Homing) {
            ops.push_back(Op::Move(b));
        }
        ops.push_back(Op::Sync);
        ops.push_back(Op::HomeFinish);
        self.ops = ops;
        self.ack_after_ops = true;
    }

    /// Ok(true) = acknowledge now; Ok(false) = queued behind a full planner,
    /// `ok` follows once it fits (GRBL blocks its protocol loop the same way).
    fn jog(&mut self, line: &str) -> Result<bool, u16> {
        if !matches!(self.state, State::Idle | State::Jog) {
            return Err(err::IDLE_ERROR);
        }
        let words = tokenize(&clean_line(line.as_bytes()))?;
        let mut inches = self.modal.inches;
        let mut absolute = self.modal.absolute;
        let mut g53 = false;
        let mut feed = None;
        let mut axes: [Option<f64>; N] = [None; N];
        for (l, v) in words {
            match l {
                'G' => match (v * 10.0).round() as i32 {
                    200 => inches = true,
                    210 => inches = false,
                    900 => absolute = true,
                    910 => absolute = false,
                    530 => g53 = true,
                    _ => return Err(err::INVALID_JOG_COMMAND),
                },
                'F' => feed = Some(v),
                'N' => {}
                'X' => axes[0] = Some(v),
                'Y' => axes[1] = Some(v),
                'Z' => axes[2] = Some(v),
                'A' if self.cfg.axes > 3 => axes[3] = Some(v),
                _ => return Err(err::INVALID_JOG_COMMAND),
            }
        }
        let mut feed = feed.ok_or(err::UNDEFINED_FEED_RATE)?;
        if axes.iter().all(|a| a.is_none()) {
            return Err(err::NO_AXIS_WORDS);
        }
        if inches {
            feed *= MM_PER_INCH;
        }
        let target = self.resolve_target(&axes, inches, absolute, g53);
        if self.flag(20) && !self.within_limits(&target) {
            return Err(err::TRAVEL_EXCEEDED);
        }
        if let Some(b) = self.make_block(self.gc_pos, target, feed, BlockKind::Jog) {
            self.gc_pos = target;
            if self.planner_used() >= self.cfg.planner_blocks {
                self.ops.push_back(Op::Move(b));
                self.ack_after_ops = true;
                return Ok(false);
            }
            self.queue_block(b);
        }
        Ok(true)
    }

    // ----- G-code execution ---------------------------------------------------

    fn wco(&self) -> Pos {
        let w = self.wcs[self.modal.wcs];
        let mut o = [0.0; N];
        for i in 0..N {
            o[i] = w[i] + self.g92[i];
        }
        o[2] += self.tlo;
        o
    }

    fn resolve_target(&self, axes: &[Option<f64>; N], inches: bool, absolute: bool, g53: bool) -> Pos {
        let wco = self.wco();
        let mut t = self.gc_pos;
        for i in 0..N {
            if let Some(mut v) = axes[i] {
                if inches && i < 3 {
                    v *= MM_PER_INCH;
                }
                t[i] = if g53 {
                    v
                } else if absolute {
                    v + wco[i]
                } else {
                    self.gc_pos[i] + v
                };
            }
        }
        t
    }

    fn within_limits(&self, p: &Pos) -> bool {
        (0..3).all(|i| {
            let travel = self.s(130 + i as u16);
            p[i] <= 1e-6 && p[i] >= -travel - 1e-6
        })
    }

    fn execute_gcode(&mut self, words: Vec<(char, f64)>, _startup: bool) -> Result<VecDeque<Op>, u16> {
        let flavor = self.cfg.flavor;
        let mut motion: Option<MotionMode> = None;
        let mut plane = None;
        let mut units = None;
        let mut distance = None;
        let mut feed_mode = None;
        let mut wcs = None;
        let mut nonmodal: Option<i32> = None;
        let mut g53 = false;
        let mut tlo: Option<bool> = None;
        let mut stop: Option<u8> = None;
        let mut spindle: Option<i8> = None;
        let mut coolant: Option<u8> = None;
        let mut groups: u32 = 0;
        let mut vals: BTreeMap<char, f64> = BTreeMap::new();

        let mut group = |g: u32| -> Result<(), u16> {
            if groups & (1 << g) != 0 {
                return Err(err::MODAL_GROUP_VIOLATION);
            }
            groups |= 1 << g;
            Ok(())
        };

        for (l, v) in words {
            match l {
                'G' => {
                    let code = (v * 10.0).round() as i32;
                    match code {
                        0 | 10 | 20 | 30 | 800 => {
                            group(1)?;
                            motion = Some(match code {
                                0 => MotionMode::Rapid,
                                10 => MotionMode::Linear,
                                20 => MotionMode::Cw,
                                30 => MotionMode::Ccw,
                                _ => MotionMode::None,
                            });
                        }
                        382..=385 => {
                            group(1)?;
                            motion = Some(MotionMode::Probe((code - 380) as u8));
                        }
                        170 | 180 | 190 => {
                            group(2)?;
                            plane = Some(((code - 170) / 10) as u8);
                        }
                        900 | 910 => {
                            group(3)?;
                            distance = Some(code == 900);
                        }
                        911 => group(4)?,
                        930 | 940 => {
                            group(5)?;
                            feed_mode = Some(code == 930);
                        }
                        200 | 210 => {
                            group(6)?;
                            units = Some(code == 200);
                        }
                        400 => group(7)?,
                        431 | 490 => {
                            group(8)?;
                            tlo = Some(code == 431);
                        }
                        540 | 550 | 560 | 570 | 580 | 590 => {
                            group(12)?;
                            wcs = Some(((code - 540) / 10) as usize);
                        }
                        610 => group(13)?,
                        40 | 100 | 280 | 281 | 300 | 301 | 920 | 921 => {
                            group(0)?;
                            nonmodal = Some(code);
                        }
                        530 => {
                            group(0)?;
                            g53 = true;
                        }
                        _ => return Err(err::UNSUPPORTED_COMMAND),
                    }
                }
                'M' => {
                    let code = v.round() as i32;
                    if (v - v.round()).abs() > 1e-6 {
                        return Err(err::COMMAND_VALUE_NOT_INTEGER);
                    }
                    match code {
                        0 | 1 | 2 | 30 => {
                            group(16)?;
                            stop = Some(code as u8);
                        }
                        3..=5 => {
                            group(17)?;
                            spindle = Some(match code {
                                3 => 1,
                                4 => -1,
                                _ => 0,
                            });
                        }
                        7 if flavor != Flavor::GrblHal => return Err(err::UNSUPPORTED_COMMAND),
                        7..=9 => {
                            group(18)?;
                            coolant = Some(code as u8);
                        }
                        6 if flavor == Flavor::GrblHal => group(19)?,
                        56 if flavor == Flavor::GrblHal => {}
                        _ => return Err(err::UNSUPPORTED_COMMAND),
                    }
                }
                'N' => {
                    if v < 0.0 || v > 9_999_999.0 {
                        return Err(err::INVALID_LINE_NUMBER);
                    }
                }
                'F' | 'S' | 'T' | 'P' | 'R' | 'L' | 'X' | 'Y' | 'Z' | 'A' | 'I' | 'J' | 'K' => {
                    if l == 'A' && self.cfg.axes < 4 {
                        return Err(err::UNSUPPORTED_COMMAND);
                    }
                    if vals.insert(l, v).is_some() {
                        return Err(err::WORD_REPEATED);
                    }
                }
                _ => return Err(err::UNSUPPORTED_COMMAND),
            }
        }

        let mut axes: [Option<f64>; N] = [vals.get(&'X').copied(), vals.get(&'Y').copied(), vals.get(&'Z').copied(), vals.get(&'A').copied()];
        let has_axes = axes.iter().any(|a| a.is_some());
        let axis_nonmodal = matches!(nonmodal, Some(100) | Some(280) | Some(300) | Some(920));
        if axis_nonmodal && motion.is_some() && has_axes {
            return Err(err::AXIS_COMMAND_CONFLICT);
        }

        // Work on a copy so a failing line leaves state untouched.
        let mut m = self.modal.clone();
        if let Some(it) = feed_mode {
            m.inverse_time = it;
        }
        if let Some(u) = units {
            m.inches = u;
        }
        let to_mm = |v: f64, inches: bool| if inches { v * MM_PER_INCH } else { v };
        let line_feed = vals.get(&'F').map(|f| to_mm(*f, m.inches));
        if let Some(f) = line_feed {
            if f < 0.0 {
                return Err(err::NEGATIVE_VALUE);
            }
            if !m.inverse_time {
                m.feed = f;
            }
        }
        if let Some(s) = vals.get(&'S') {
            if *s < 0.0 {
                return Err(err::NEGATIVE_VALUE);
            }
            m.speed = *s;
        }
        if let Some(t) = vals.get(&'T') {
            if *t > 255.0 {
                return Err(err::MAX_VALUE_EXCEEDED);
            }
            m.tool = *t as u32;
        }
        if let Some(p) = plane {
            m.plane = p;
        }
        if let Some(d) = distance {
            m.absolute = d;
        }
        if let Some(w) = wcs {
            m.wcs = w;
        }
        let effective_motion = motion.unwrap_or(m.motion);
        if let Some(mm) = motion {
            m.motion = mm;
        }

        let mut ops: VecDeque<Op> = VecDeque::new();
        let laser = self.flag(32);

        // Spindle (synchronised unless laser mode)
        let speed_changed = vals.contains_key(&'S') && (m.speed - self.modal.speed).abs() > EPS;
        if let Some(sp) = spindle {
            m.spindle = sp;
        }
        if spindle.is_some() || (speed_changed && m.spindle != 0) {
            if !laser {
                ops.push_back(Op::Sync);
            }
            ops.push_back(Op::Spindle { dir: m.spindle, speed: m.speed });
        }
        if let Some(c) = coolant {
            match c {
                7 => m.mist = true,
                8 => m.flood = true,
                _ => {
                    m.mist = false;
                    m.flood = false;
                }
            }
            ops.push_back(Op::Sync);
            ops.push_back(Op::Coolant { flood: m.flood, mist: m.mist });
        }
        if nonmodal == Some(40) {
            let p = *vals.get(&'P').ok_or(err::VALUE_WORD_MISSING)?;
            if p < 0.0 {
                return Err(err::NEGATIVE_VALUE);
            }
            ops.push_back(Op::Sync);
            ops.push_back(Op::Dwell(p));
        }

        // Validate G10 before committing anything.
        let g10 = if nonmodal == Some(100) {
            let l = vals.get(&'L').copied().unwrap_or(-1.0) as i32;
            let p = vals.get(&'P').copied().ok_or(err::VALUE_WORD_MISSING)?;
            if p < 0.0 || p > 6.0 || !(l == 2 || l == 20) {
                return Err(err::UNSUPPORTED_COMMAND);
            }
            let idx = if p < 0.5 { m.wcs } else { p as usize - 1 };
            Some((l, idx))
        } else {
            None
        };

        // Commit modal state needed by target resolution
        let prev_modal = std::mem::replace(&mut self.modal, m);
        let restore = |s: &mut Self, prev: Modal| s.modal = prev;

        if let Some(on) = tlo {
            if on {
                let z = match axes[2].take() {
                    Some(z) => z,
                    None => {
                        restore(self, prev_modal);
                        return Err(err::VALUE_WORD_MISSING);
                    }
                };
                self.tlo = to_mm(z, self.modal.inches);
            } else {
                self.tlo = 0.0;
            }
            self.wco_counter = 0;
        }
        if wcs.is_some() {
            self.wco_counter = 0;
        }
        if g53 && !matches!(effective_motion, MotionMode::Rapid | MotionMode::Linear) {
            restore(self, prev_modal);
            return Err(err::G53_INVALID_MOTION_MODE);
        }

        let inches = self.modal.inches;
        match nonmodal {
            Some(100) => {
                let (l, idx) = g10.expect("validated above");
                for i in 0..N {
                    if let Some(v) = axes[i] {
                        let v = if i < 3 { to_mm(v, inches) } else { v };
                        self.wcs[idx][i] = if l == 2 {
                            v
                        } else {
                            let mut o = self.gc_pos[i] - self.g92[i] - v;
                            if i == 2 {
                                o -= self.tlo;
                            }
                            o
                        };
                    }
                }
                self.wco_counter = 0;
                axes = [None; N];
            }
            Some(281) => self.g28 = self.gc_pos,
            Some(301) => self.g30 = self.gc_pos,
            Some(920) => {
                if !has_axes {
                    restore(self, prev_modal);
                    return Err(err::NO_AXIS_WORDS);
                }
                for i in 0..N {
                    if let Some(v) = axes[i] {
                        let v = if i < 3 { to_mm(v, inches) } else { v };
                        let mut o = self.gc_pos[i] - self.wcs[self.modal.wcs][i] - v;
                        if i == 2 {
                            o -= self.tlo;
                        }
                        self.g92[i] = o;
                    }
                }
                self.wco_counter = 0;
                axes = [None; N];
            }
            Some(921) => {
                self.g92 = [0.0; N];
                self.wco_counter = 0;
            }
            Some(280) | Some(300) => {
                let stored = if nonmodal == Some(280) { self.g28 } else { self.g30 };
                let final_t = if has_axes {
                    let mid = self.resolve_target(&axes, inches, self.modal.absolute, false);
                    if let Err(e) = self.push_line_move(&mut ops, mid, 0.0, BlockKind::Rapid) {
                        restore(self, prev_modal);
                        return Err(e);
                    }
                    // Only the named axes continue to the stored position.
                    let mut t = mid;
                    for i in 0..N {
                        if axes[i].is_some() {
                            t[i] = stored[i];
                        }
                    }
                    t
                } else {
                    stored
                };
                if let Err(e) = self.push_line_move(&mut ops, final_t, 0.0, BlockKind::Rapid) {
                    restore(self, prev_modal);
                    return Err(e);
                }
                axes = [None; N];
            }
            _ => {}
        }

        let has_axes = axes.iter().any(|a| a.is_some());
        if has_axes {
            let target = self.resolve_target(&axes, inches, self.modal.absolute, g53);
            let res = match effective_motion {
                MotionMode::None => Err(err::AXIS_WORDS_EXIST),
                MotionMode::Rapid => self.push_line_move(&mut ops, target, 0.0, BlockKind::Rapid),
                MotionMode::Linear => match self.motion_feed(line_feed, target) {
                    Ok(f) => self.push_line_move(&mut ops, target, f, BlockKind::Feed),
                    Err(e) => Err(e),
                },
                MotionMode::Cw | MotionMode::Ccw => match self.motion_feed(line_feed, target) {
                    Ok(f) => self.push_arc(&mut ops, target, &vals, effective_motion == MotionMode::Cw, f),
                    Err(e) => Err(e),
                },
                MotionMode::Probe(n) => match self.motion_feed(line_feed, target) {
                    Ok(f) => {
                        if (0..N).all(|i| (target[i] - self.gc_pos[i]).abs() < EPS) {
                            Err(err::INVALID_TARGET)
                        } else {
                            ops.push_back(Op::Sync);
                            ops.push_back(Op::Probe { target, feed: f, toward: n <= 3, error_on_fail: n == 2 || n == 4 });
                            Ok(())
                        }
                    }
                    Err(e) => Err(e),
                },
            };
            if let Err(e) = res {
                restore(self, prev_modal);
                return Err(e);
            }
        } else if matches!(motion, Some(MotionMode::Cw | MotionMode::Ccw)) {
            restore(self, prev_modal);
            return Err(err::NO_AXIS_WORDS_IN_PLANE);
        } else if matches!(motion, Some(MotionMode::Probe(_))) {
            restore(self, prev_modal);
            return Err(err::NO_AXIS_WORDS);
        }

        match stop {
            Some(0) => {
                ops.push_back(Op::Sync);
                ops.push_back(Op::Pause);
            }
            Some(2) | Some(30) => {
                ops.push_back(Op::Sync);
                ops.push_back(Op::ProgramEnd);
            }
            _ => {}
        }

        if self.state == State::Check {
            // Parse-only: keep the parser state, discard physical actions.
            return Ok(VecDeque::new());
        }
        Ok(ops)
    }

    fn motion_feed(&self, line_feed: Option<f64>, target: Pos) -> Result<f64, u16> {
        if self.modal.inverse_time {
            let f = line_feed.ok_or(err::UNDEFINED_FEED_RATE)?;
            let len = dist(&self.gc_pos, &target);
            // F is 1/minutes: feed (mm/min) = len * F
            return Ok((len * f).max(1.0));
        }
        if self.modal.feed <= 0.0 {
            return Err(err::UNDEFINED_FEED_RATE);
        }
        Ok(self.modal.feed)
    }

    fn push_line_move(&mut self, ops: &mut VecDeque<Op>, target: Pos, feed: f64, kind: BlockKind) -> Result<(), u16> {
        if self.flag(20) && !self.within_limits(&target) && self.state != State::Check {
            self.alarm(2);
            return Err(0);
        }
        if let Some(b) = self.make_block(self.gc_pos, target, feed, kind) {
            ops.push_back(Op::Move(b));
        }
        self.gc_pos = target;
        Ok(())
    }

    fn push_arc(&mut self, ops: &mut VecDeque<Op>, target: Pos, vals: &BTreeMap<char, f64>, cw: bool, feed: f64) -> Result<(), u16> {
        let (a0, a1, lin) = match self.modal.plane {
            0 => (0, 1, 2),
            1 => (2, 0, 1),
            _ => (1, 2, 0),
        };
        let start = self.gc_pos;
        let inches = self.modal.inches;
        let to_mm = |v: f64| if inches { v * MM_PER_INCH } else { v };
        let off_letter = |axis: usize| match axis {
            0 => 'I',
            1 => 'J',
            _ => 'K',
        };
        let (off0, off1);
        if let Some(r) = vals.get(&'R') {
            let r = to_mm(*r);
            let x = target[a0] - start[a0];
            let y = target[a1] - start[a1];
            if x.abs() < EPS && y.abs() < EPS {
                return Err(err::INVALID_TARGET);
            }
            let mut h = 4.0 * r * r - x * x - y * y;
            if h < 0.0 {
                return Err(err::ARC_RADIUS_ERROR);
            }
            h = -h.sqrt() / x.hypot(y);
            if !cw {
                h = -h;
            }
            // Negative R selects the long way round (> 180°).
            if r < 0.0 {
                h = -h;
            }
            off0 = 0.5 * (x - y * h);
            off1 = 0.5 * (y + x * h);
        } else {
            let i0 = vals.get(&off_letter(a0)).copied();
            let i1 = vals.get(&off_letter(a1)).copied();
            if i0.is_none() && i1.is_none() {
                return Err(err::NO_OFFSETS_IN_PLANE);
            }
            off0 = to_mm(i0.unwrap_or(0.0));
            off1 = to_mm(i1.unwrap_or(0.0));
            let r_start = off0.hypot(off1);
            let c0 = start[a0] + off0;
            let c1 = start[a1] + off1;
            let r_end = (target[a0] - c0).hypot(target[a1] - c1);
            let delta = (r_end - r_start).abs();
            if delta > 0.005 && (delta > 0.5 || delta > 0.001 * r_start) {
                return Err(err::INVALID_TARGET);
            }
        }
        let radius = off0.hypot(off1);
        let c0 = start[a0] + off0;
        let c1 = start[a1] + off1;
        let r0 = -off0;
        let r1 = -off1;
        let rt0 = target[a0] - c0;
        let rt1 = target[a1] - c1;
        let mut ang = (r0 * rt1 - r1 * rt0).atan2(r0 * rt0 + r1 * rt1);
        const ANG_EPS: f64 = 5e-7;
        if cw {
            if ang >= -ANG_EPS {
                ang -= 2.0 * std::f64::consts::PI;
            }
        } else if ang <= ANG_EPS {
            ang += 2.0 * std::f64::consts::PI;
        }
        let tol = self.s(12).max(0.0001);
        let seg_len = (tol * (2.0 * radius - tol)).max(1e-6).sqrt();
        let segments = ((0.5 * ang * radius).abs() / seg_len).floor().max(1.0) as usize;
        let theta = ang / segments as f64;
        let lin_step = (target[lin] - start[lin]) / segments as f64;
        let other: Vec<usize> = (0..N).filter(|i| *i != a0 && *i != a1 && *i != lin).collect();
        for s in 1..=segments {
            let mut p = start;
            if s == segments {
                p = target;
            } else {
                let a = theta * s as f64;
                let (sin, cos) = a.sin_cos();
                p[a0] = c0 + r0 * cos - r1 * sin;
                p[a1] = c1 + r0 * sin + r1 * cos;
                p[lin] = start[lin] + lin_step * s as f64;
                for &o in &other {
                    p[o] = start[o] + (target[o] - start[o]) * s as f64 / segments as f64;
                }
            }
            self.push_line_move(ops, p, feed, BlockKind::Feed)?;
        }
        Ok(())
    }

    // ----- planner ------------------------------------------------------------

    fn make_block(&self, start: Pos, target: Pos, feed: f64, kind: BlockKind) -> Option<Block> {
        let mut d = [0.0; N];
        for i in 0..N {
            d[i] = target[i] - start[i];
        }
        let len = d.iter().map(|x| x * x).sum::<f64>().sqrt();
        if len < 1e-6 {
            return None;
        }
        let unit = d.map(|x| x / len);
        let mut accel = f64::INFINITY;
        let mut axis_limit = f64::INFINITY;
        for (i, u) in unit.iter().enumerate().take(self.cfg.axes) {
            let u = u.abs();
            if u > 1e-9 {
                accel = accel.min(self.s(120 + i as u16).max(0.1) / u);
                axis_limit = axis_limit.min(self.s(110 + i as u16).max(1.0) / 60.0 / u);
            }
        }
        if !accel.is_finite() {
            accel = 10.0;
        }
        if !axis_limit.is_finite() {
            axis_limit = 1.0;
        }
        Some(Block { kind, start, target, unit, len, feed, accel, axis_limit, junction_max: 0.0, entry: 0.0 })
    }

    fn nominal(&self, b: &Block) -> f64 {
        match b.kind {
            BlockKind::Rapid => b.axis_limit * self.rapid_ovr as f64 / 100.0,
            BlockKind::Feed => (b.feed / 60.0 * self.feed_ovr as f64 / 100.0).min(b.axis_limit),
            BlockKind::Jog | BlockKind::Homing | BlockKind::Probe => (b.feed / 60.0).min(b.axis_limit),
        }
    }

    fn queue_block(&mut self, mut b: Block) {
        // Junction deviation (GRBL planner.c)
        b.junction_max = match self.last_unit {
            None => 0.0,
            Some(prev) => {
                let cos = -(0..N).map(|i| prev[i] * b.unit[i]).sum::<f64>();
                if cos > 0.999_999 {
                    0.0
                } else if cos < -0.999_999 {
                    f64::INFINITY
                } else {
                    let sin_half = (0.5 * (1.0 - cos)).sqrt();
                    (b.accel * self.s(11).max(0.001) * sin_half / (1.0 - sin_half)).sqrt()
                }
            }
        };
        if b.kind == BlockKind::Probe || b.kind == BlockKind::Homing {
            b.junction_max = 0.0;
        }
        self.last_unit = Some(b.unit);
        let kind = b.kind;
        self.planner.push_back(b);
        self.stats.max_planner_used = self.stats.max_planner_used.max(self.planner_used());
        self.replan_needed = true;
        match (self.state, kind) {
            (State::Idle, BlockKind::Jog) => self.state = State::Jog,
            (State::Idle, BlockKind::Homing) => {}
            (State::Idle, _) => self.state = State::Run,
            _ => {}
        }
    }

    fn replan(&mut self) {
        let mut next_entry = 0.0_f64;
        for i in (0..self.planner.len()).rev() {
            let nominal = self.nominal(&self.planner[i]);
            let b = &mut self.planner[i];
            let max_entry = b.junction_max.min(nominal);
            b.entry = max_entry.min((next_entry * next_entry + 2.0 * b.accel * b.len).sqrt());
            next_entry = b.entry;
        }
        self.cur_exit = self.planner.front().map(|b| b.entry).unwrap_or(0.0);
    }

    fn probe_contact(&self) -> bool {
        if let Some(f) = self.forced_probe {
            return f;
        }
        self.cfg.probe.boxes.iter().any(|b| b.contains(&self.pos))
    }

    fn advance(&mut self, h: f64) {
        if let Some(left) = self.dwell_left.as_mut() {
            if !matches!(self.state, State::Hold(_)) {
                *left -= h;
            }
        }
        if self.current.is_none() {
            let blocked = matches!(self.state, State::Hold(_) | State::Alarm | State::Sleep);
            if !blocked {
                if let Some(b) = self.planner.pop_front() {
                    self.current = Some(Exec { block: b, traveled: 0.0 });
                    self.replan_needed = true;
                }
            }
            if self.current.is_none() {
                self.v = 0.0;
                self.on_motion_idle();
                return;
            }
        }
        if self.replan_needed {
            self.replan();
            self.replan_needed = false;
        }
        let holding = matches!(self.state, State::Hold(_)) || self.jog_cancel;
        let (vmax, accel, len, traveled, kind) = {
            let e = self.current.as_ref().expect("current block");
            (self.nominal(&e.block), e.block.accel, e.block.len, e.traveled, e.block.kind)
        };
        let remaining = len - traveled;
        let mut v = self.v;
        if holding {
            v = (v - accel * h).max(0.0);
        } else {
            let exit = self.cur_exit.min(vmax);
            let decel_dist = (v * v - exit * exit).max(0.0) / (2.0 * accel);
            if remaining <= decel_dist + 1e-9 {
                v = (v - accel * h).max(exit);
            } else if v < vmax {
                v = (v + accel * h).min(vmax);
            } else {
                v = (v - accel * h).max(vmax);
            }
            if v < 1e-6 {
                v = (accel * h).min(vmax);
            }
        }
        let ds = (v * h).min(remaining);
        self.v = v;
        let (finished, pos) = {
            let e = self.current.as_mut().expect("current block");
            e.traveled += ds;
            let finished = e.traveled >= e.block.len - 1e-9;
            let mut p = e.block.target;
            if !finished {
                for i in 0..N {
                    p[i] = e.block.start[i] + e.block.unit[i] * e.traveled;
                }
            }
            (finished, p)
        };
        self.pos = pos;

        if kind == BlockKind::Probe {
            if let Some(run) = self.probe_run.as_ref() {
                let contact = self.probe_contact();
                if contact == run.toward {
                    self.v = 0.0;
                    self.current = None;
                    self.planner.clear();
                    self.gc_pos = self.pos;
                    self.last_unit = None;
                    if let Some(r) = self.probe_run.as_mut() {
                        r.result = Some(true);
                    }
                    return;
                }
            }
        }
        if finished {
            self.current = None;
            self.replan_needed = true;
            if kind == BlockKind::Probe {
                if let Some(r) = self.probe_run.as_mut() {
                    r.result = Some(false);
                }
            }
        }
        if holding && self.v <= EPS {
            if self.jog_cancel {
                self.jog_cancel = false;
                self.flush_motion();
                self.ops.retain(|o| !matches!(o, Op::Move(b) if b.kind == BlockKind::Jog));
                self.state = State::Idle;
            } else if self.state == State::Hold(1) {
                self.state = State::Hold(0);
            }
        }
    }

    fn on_motion_idle(&mut self) {
        match self.state {
            State::Run | State::Jog => {
                self.state = State::Idle;
                self.last_unit = None;
            }
            State::Hold(1) => self.state = State::Hold(0),
            _ => {}
        }
        if self.jog_cancel {
            self.jog_cancel = false;
        }
    }

    fn motion_idle(&self) -> bool {
        self.current.is_none() && self.planner.is_empty()
    }

    /// Run queued ops. Returns true when all are done.
    fn run_ops(&mut self) -> bool {
        while let Some(op) = self.ops.front().cloned() {
            match op {
                Op::Sync => {
                    if !self.motion_idle() || matches!(self.state, State::Hold(_)) {
                        return false;
                    }
                }
                Op::Move(b) => {
                    if self.planner_used() >= self.cfg.planner_blocks {
                        return false;
                    }
                    if self.state == State::Alarm {
                        self.ops.clear();
                        return true;
                    }
                    self.queue_block(b);
                }
                Op::Spindle { dir, speed } => {
                    self.act_spindle = (dir, speed);
                    self.ovr_counter = 0;
                }
                Op::Coolant { flood, mist } => {
                    self.act_flood = flood;
                    self.act_mist = mist;
                    self.ovr_counter = 0;
                }
                Op::Dwell(secs) => match self.dwell_left {
                    None => {
                        self.dwell_left = Some(secs);
                        return false;
                    }
                    Some(left) if left > 0.0 => return false,
                    Some(_) => self.dwell_left = None,
                },
                Op::Probe { target, feed, toward, error_on_fail } => {
                    match &self.probe_run {
                        None => {
                            if self.probe_contact() == toward {
                                self.ops.clear();
                                self.ack_after_ops = false;
                                self.alarm(4);
                                return true;
                            }
                            self.probe_run = Some(ProbeRun { toward, error_on_fail, result: None });
                            if let Some(b) = self.make_block(self.pos, target, feed, BlockKind::Probe) {
                                self.last_unit = None;
                                self.queue_block(b);
                            }
                            return false;
                        }
                        Some(run) if run.result.is_none() => return false,
                        Some(run) => {
                            let ok = run.result == Some(true);
                            let err_on_fail = run.error_on_fail;
                            self.probe_run = None;
                            self.prb = (self.pos, ok);
                            self.gc_pos = self.pos;
                            if !ok && err_on_fail {
                                self.state = State::Alarm;
                                self.emit_alarm(5);
                            } else if self.state == State::Run {
                                self.state = State::Idle;
                            }
                            let p = fmt_pos(&self.pos, self.cfg.axes, false);
                            let line = format!("[PRB:{p}:{}]", u8::from(ok));
                            self.emit(&line);
                        }
                    }
                }
                Op::Pause => {
                    self.state = State::Hold(0);
                }
                Op::ProgramEnd => {
                    self.modal = Modal {
                        motion: MotionMode::Linear,
                        inches: self.modal.inches,
                        tool: self.modal.tool,
                        ..Modal::default()
                    };
                    self.wco_counter = 0;
                    self.act_spindle = (0, 0.0);
                    self.act_flood = false;
                    self.act_mist = false;
                    self.feed_ovr = 100;
                    self.rapid_ovr = 100;
                    self.spindle_ovr = 100;
                    self.ovr_counter = 0;
                    self.msg("Pgm End");
                }
                Op::HomeFinish => {
                    self.homed = true;
                    self.state = State::Idle;
                    self.gc_pos = self.pos;
                    self.last_unit = None;
                }
            }
            self.ops.pop_front();
        }
        true
    }

    // ----- status report ------------------------------------------------------

    fn state_str(&self) -> String {
        let legacy = self.cfg.flavor.legacy();
        match self.state {
            State::Idle => "Idle".into(),
            State::Run => "Run".into(),
            State::Hold(n) => {
                if legacy {
                    "Hold".into()
                } else {
                    format!("Hold:{n}")
                }
            }
            State::Jog => "Jog".into(),
            State::Alarm => "Alarm".into(),
            State::Check => "Check".into(),
            State::Home => "Home".into(),
            State::Sleep => "Sleep".into(),
        }
    }

    fn status_report(&mut self) -> String {
        let axes = self.cfg.axes;
        let inches = self.flag(13);
        let wco = self.wco();
        let wpos: Pos = [0, 1, 2, 3].map(|i| self.pos[i] - wco[i]);
        let state = self.state_str();
        if self.cfg.flavor.legacy() {
            return format!("<{state},MPos:{},WPos:{}>", fmt_pos(&self.pos, axes, inches), fmt_pos(&wpos, axes, inches));
        }
        let mask = self.s(10) as u32;
        let mut s = format!("<{state}");
        if mask & 1 != 0 {
            s += &format!("|MPos:{}", fmt_pos(&self.pos, axes, inches));
        } else {
            s += &format!("|WPos:{}", fmt_pos(&wpos, axes, inches));
        }
        if mask & 2 != 0 {
            let planner_free = self.cfg.planner_blocks.saturating_sub(self.planner_used());
            let rx_free = self.cfg.rx_buffer_size - self.rx.len();
            s += &format!("|Bf:{planner_free},{rx_free}");
        }
        let feed = if inches { self.v * 60.0 / MM_PER_INCH } else { self.v * 60.0 };
        let speed = if self.act_spindle.0 == 0 { 0.0 } else { self.act_spindle.1 * self.spindle_ovr as f64 / 100.0 };
        s += &format!("|FS:{},{}", feed.round() as i64, speed.round() as i64);
        let probe = self.probe_contact();
        if probe {
            s += "|Pn:P";
        }
        let busy = matches!(self.state, State::Run | State::Hold(_) | State::Jog | State::Home);
        if self.wco_counter > 0 {
            self.wco_counter -= 1;
        } else {
            self.wco_counter = if busy { 29 } else { 9 };
            if self.ovr_counter == 0 {
                self.ovr_counter = 1;
            }
            s += &format!("|WCO:{}", fmt_pos(&wco, axes, inches));
        }
        if self.ovr_counter > 0 {
            self.ovr_counter -= 1;
        } else {
            self.ovr_counter = if busy { 19 } else { 9 };
            s += &format!("|Ov:{},{},{}", self.feed_ovr, self.rapid_ovr, self.spindle_ovr);
            let mut a = String::new();
            match self.act_spindle.0 {
                1 => a.push('S'),
                -1 => a.push('C'),
                _ => {}
            }
            if self.act_flood {
                a.push('F');
            }
            if self.act_mist {
                a.push('M');
            }
            if !a.is_empty() {
                s += &format!("|A:{a}");
            }
        }
        s.push('>');
        s
    }
}

fn dist(a: &Pos, b: &Pos) -> f64 {
    (0..N).map(|i| (a[i] - b[i]).powi(2)).sum::<f64>().sqrt()
}

fn fmt_pos(p: &Pos, axes: usize, inches: bool) -> String {
    p.iter()
        .take(axes)
        .enumerate()
        .map(|(i, v)| {
            if inches && i < 3 {
                format!("{:.4}", v / MM_PER_INCH)
            } else {
                format!("{v:.3}")
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn trim_num(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        let s = format!("{v:.3}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn legacy_error_text(code: u16) -> String {
    match code {
        1 => "Expected command letter".into(),
        2 => "Bad number format".into(),
        3 => "Invalid statement".into(),
        4 => "Value < 0".into(),
        5 => "Setting disabled".into(),
        6 => "Value < 3 usec".into(),
        8 => "Busy or queued commands".into(),
        9 => "Alarm lock".into(),
        10 => "Homing not enabled".into(),
        11 => "Line overflow".into(),
        20 => "Unsupported command".into(),
        21 => "Modal group violation".into(),
        22 => "Undefined feed rate".into(),
        n => format!("Invalid gcode ID:{n}"),
    }
}

fn legacy_alarm_text(code: u16) -> &'static str {
    match code {
        1 | 2 => "Hard/soft limit",
        3 => "Abort during cycle",
        4 | 5 => "Probe fail",
        _ => "Homing fail",
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use grbl_core::protocol::{parse_line, GrblLine};

    fn dev(flavor: Flavor) -> VirtualGrbl {
        let mut cfg = VirtualConfig::new(flavor);
        cfg.settings.insert(110, 6000.0);
        cfg.settings.insert(111, 6000.0);
        cfg.settings.insert(112, 1200.0);
        cfg.settings.insert(120, 500.0);
        cfg.settings.insert(121, 500.0);
        cfg.settings.insert(122, 200.0);
        let mut d = VirtualGrbl::new(cfg);
        d.take_output();
        d
    }

    fn lines(d: &mut VirtualGrbl) -> Vec<String> {
        String::from_utf8(d.take_output())
            .unwrap()
            .split("\r\n")
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect()
    }

    fn send(d: &mut VirtualGrbl, s: &str) -> Vec<String> {
        d.receive(format!("{s}\n").as_bytes());
        d.step(0.001);
        lines(d)
    }

    fn run(d: &mut VirtualGrbl, secs: f64) -> Vec<String> {
        let mut t = 0.0;
        while t < secs {
            d.step(0.01);
            t += 0.01;
        }
        lines(d)
    }

    fn status(d: &mut VirtualGrbl) -> String {
        d.receive(b"?");
        d.step(0.0001);
        lines(d).into_iter().find(|l| l.starts_with('<')).unwrap()
    }

    #[test]
    fn welcome_and_basic_queries() {
        let mut d = VirtualGrbl::new(VirtualConfig::new(Flavor::Grbl11));
        let out = lines(&mut d);
        assert!(out.iter().any(|l| l == "Grbl 1.1h ['$' for help]"));
        let s = send(&mut d, "$$");
        assert!(s.contains(&"$110=500.000".to_string()));
        assert!(s.contains(&"$22=0".to_string()));
        assert_eq!(s.last().unwrap(), "ok");
        let g = send(&mut d, "$G");
        assert_eq!(g[0], "[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]");
        let h = send(&mut d, "$#");
        assert!(h[0].starts_with("[G54:"));
        assert!(h.iter().any(|l| l.starts_with("[TLO:")));
        let i = send(&mut d, "$I");
        assert!(i[0].starts_with("[VER:1.1h"));
    }

    #[test]
    fn errors_match_grbl_codes() {
        let mut d = dev(Flavor::Grbl11);
        assert_eq!(send(&mut d, "G1 X10"), vec!["error:22"]);
        assert_eq!(send(&mut d, "M6"), vec!["error:20"]);
        assert_eq!(send(&mut d, "M7"), vec!["error:20"]);
        assert_eq!(send(&mut d, "G0 G1 X1"), vec!["error:21"]);
        assert_eq!(send(&mut d, "G1 X1 X2 F100"), vec!["error:25"]);
        assert_eq!(send(&mut d, "G4"), vec!["error:28"]);
        assert_eq!(send(&mut d, "$999=1"), vec!["error:3"]);
        assert_eq!(send(&mut d, "$H"), vec!["error:5"]);
        assert_eq!(send(&mut d, "$20=1"), vec!["error:10"]);
        let long = format!("G0 X{}", "1".repeat(90));
        assert_eq!(send(&mut d, &long), vec!["error:11"]);
        assert_eq!(send(&mut d, ""), vec!["ok"]);
    }

    #[test]
    fn settings_write_and_read_back() {
        let mut d = dev(Flavor::Grbl11);
        assert_eq!(send(&mut d, "$110=1234.5"), vec!["ok"]);
        assert_eq!(d.setting(110), Some(1234.5));
        assert_eq!(send(&mut d, "$110=-1"), vec!["error:4"]);
    }

    #[test]
    fn rapid_move_takes_realistic_time_with_acceleration() {
        let mut d = dev(Flavor::Grbl11);
        send(&mut d, "G0 X-100");
        // 100 mm at 6000 mm/min (100 mm/s) with 500 mm/s²: t = d/v + v/a = 1.0 + 0.2 = 1.2 s
        let mut t = 0.0_f64;
        while d.state_name() != "Run" && t < 0.1 {
            d.step(0.001);
            t += 0.001;
        }
        let mut t = 0.0_f64;
        while d.state_name() == "Run" && t < 5.0 {
            d.step(0.001);
            t += 0.001;
        }
        assert!((t - 1.2).abs() < 0.05, "took {t}");
        assert!((d.machine_pos()[0] + 100.0).abs() < 1e-6);
    }

    #[test]
    fn junction_speed_keeps_collinear_moves_fast() {
        let mut d = dev(Flavor::Grbl11);
        // 8 lines × 14 bytes fit in the 128-byte RX buffer.
        for i in 1..=8 {
            d.receive(format!("G1 X-{} F6000\n", i * 10).as_bytes());
        }
        assert_eq!(d.stats().rx_overflows, 0);
        let mut t = 0.0;
        d.step(0.001);
        while d.state_name() == "Run" && t < 10.0 {
            d.step(0.001);
            t += 0.001;
        }
        // Same as one 80 mm move: ~1.0 s, not 8 × (0.1 + 0.2) = 2.4 s
        assert!(t < 1.15, "took {t}");
        assert!((d.machine_pos()[0] + 80.0).abs() < 1e-6);
    }

    #[test]
    fn rx_buffer_overflow_is_detected() {
        let mut d = dev(Flavor::Grbl11);
        let big = "G1 X-1 F100\n".repeat(20); // 240 bytes > 128
        d.receive(big.as_bytes());
        assert!(d.stats().rx_overflows > 0);
        assert_eq!(d.rx_used(), 128);
    }

    #[test]
    fn planner_fills_and_ok_is_delayed() {
        let mut d = dev(Flavor::Grbl11);
        let mut oks = 0;
        for i in 0..30 {
            d.receive(format!("G1 X-{}.0 F100\n", i + 1).as_bytes());
            d.step(0.0001);
            oks += lines(&mut d).iter().filter(|l| *l == "ok").count();
        }
        // Only planner_blocks (+1 executing) lines can be acknowledged quickly.
        assert!(oks <= 17, "oks = {oks}");
        assert!(d.planner_used() >= 15);
    }

    #[test]
    fn feed_hold_and_resume() {
        let mut d = dev(Flavor::Grbl11);
        send(&mut d, "G1 X-50 F3000");
        run(&mut d, 0.3);
        d.receive(b"!");
        run(&mut d, 0.01);
        assert_eq!(d.state_name(), "Hold:1");
        run(&mut d, 0.5);
        assert_eq!(d.state_name(), "Hold:0");
        let held = d.machine_pos()[0];
        run(&mut d, 0.5);
        assert_eq!(d.machine_pos()[0], held);
        d.receive(b"~");
        run(&mut d, 3.0);
        assert_eq!(d.state_name(), "Idle");
        assert!((d.machine_pos()[0] + 50.0).abs() < 1e-6);
    }

    #[test]
    fn reset_during_motion_raises_alarm_3() {
        let mut d = dev(Flavor::Grbl11);
        send(&mut d, "G0 X-100");
        run(&mut d, 0.2);
        d.receive(&[0x18]);
        let out = lines(&mut d);
        assert!(out.contains(&"ALARM:3".to_string()), "{out:?}");
        assert!(out.iter().any(|l| l.starts_with("Grbl 1.1h")));
        assert_eq!(d.state_name(), "Alarm");
        assert_eq!(send(&mut d, "G0 X0"), vec!["error:9"]);
        assert_eq!(send(&mut d, "$X"), vec!["[MSG:Caution: Unlocked]", "ok"]);
        assert_eq!(d.state_name(), "Idle");
    }

    #[test]
    fn reset_after_completed_hold_keeps_position() {
        let mut d = dev(Flavor::Grbl11);
        send(&mut d, "G1 X-80 F3000");
        run(&mut d, 0.3);
        d.receive(b"!");
        run(&mut d, 0.5);
        assert_eq!(d.state_name(), "Hold:0");
        let x = d.machine_pos()[0];
        d.receive(&[0x18]);
        let out = lines(&mut d);
        assert!(!out.contains(&"ALARM:3".to_string()), "{out:?}");
        assert_eq!(d.state_name(), "Idle");
        assert_eq!(d.machine_pos()[0], x);
    }

    #[test]
    fn jog_and_jog_cancel() {
        let mut d = dev(Flavor::Grbl11);
        assert_eq!(send(&mut d, "$J=G91 X-100 F3000"), vec!["ok"]);
        run(&mut d, 0.3);
        assert_eq!(d.state_name(), "Jog");
        d.receive(&[0x85]);
        run(&mut d, 0.5);
        assert_eq!(d.state_name(), "Idle");
        let x = d.machine_pos()[0];
        assert!(x < -1.0 && x > -50.0, "x = {x}");
        assert_eq!(send(&mut d, "$J=G91 X10"), vec!["error:22"]);
        assert_eq!(send(&mut d, "$J=G91 M3 X10 F100"), vec!["error:16"]);
    }

    #[test]
    fn soft_limits_on_jog_and_gcode() {
        let mut cfg = VirtualConfig::new(Flavor::Grbl11);
        cfg.settings.insert(22, 1.0);
        cfg.settings.insert(20, 1.0);
        let mut d = VirtualGrbl::new(cfg);
        lines(&mut d);
        assert_eq!(d.state_name(), "Alarm");
        send(&mut d, "$X");
        assert_eq!(send(&mut d, "$J=G91 X10 F1000"), vec!["error:15"]);
        let out = send(&mut d, "G0 X10");
        assert!(out.contains(&"ALARM:2".to_string()), "{out:?}");
        assert!(out.contains(&"[MSG:Reset to continue]".to_string()));
    }

    #[test]
    fn homing_moves_to_home_position() {
        let mut cfg = VirtualConfig::new(Flavor::Grbl11);
        cfg.settings.insert(22, 1.0);
        cfg.settings.insert(23, 3.0); // X,Y home negative
        cfg.settings.insert(27, 2.0);
        cfg.settings.insert(25, 3000.0);
        cfg.settings.insert(120, 500.0);
        cfg.settings.insert(121, 500.0);
        cfg.settings.insert(122, 500.0);
        cfg.settings.insert(110, 5000.0);
        cfg.settings.insert(111, 5000.0);
        cfg.settings.insert(112, 5000.0);
        let mut d = VirtualGrbl::new(cfg);
        lines(&mut d);
        d.receive(b"$H\n");
        run(&mut d, 0.05);
        assert_eq!(d.state_name(), "Home");
        let out = run(&mut d, 10.0);
        assert_eq!(out, vec!["ok"]);
        assert_eq!(d.state_name(), "Idle");
        let p = d.machine_pos();
        assert!((p[0] - (-198.0)).abs() < 1e-6 && (p[1] - (-198.0)).abs() < 1e-6 && (p[2] + 2.0).abs() < 1e-6, "{p:?}");
    }

    #[test]
    fn probe_finds_surface_and_reports_prb() {
        let mut d = dev(Flavor::Grbl11);
        // Surface box top is at machine Z -150 under the whole default area.
        send(&mut d, "G0 X-50 Y-50");
        run(&mut d, 2.0);
        d.receive(b"G38.2 Z-180 F600\n");
        let out = run(&mut d, 30.0);
        let prb = out.iter().find(|l| l.starts_with("[PRB:")).expect("PRB");
        match parse_line(prb) {
            GrblLine::Probe { position, success } => {
                assert!(success);
                assert!((position[2] + 150.0).abs() < 0.05, "{position:?}");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(out.last().unwrap(), "ok");
        // Already touching → ALARM:4
        let out = send(&mut d, "G38.2 Z-160 F100");
        let out2 = run(&mut d, 0.1);
        assert!(out.iter().chain(out2.iter()).any(|l| l == "ALARM:4"), "{out:?} {out2:?}");
    }

    #[test]
    fn probe_miss_alarms_5_for_g38_2_but_not_g38_3() {
        let mut d = dev(Flavor::Grbl11);
        d.receive(b"G38.3 Z-5 F600\n");
        let out = run(&mut d, 3.0);
        assert!(out.contains(&"[PRB:0.000,0.000,-5.000:0]".to_string()), "{out:?}");
        assert_eq!(d.state_name(), "Idle");
        d.receive(b"G38.2 Z-10 F600\n");
        let out = run(&mut d, 3.0);
        assert!(out.contains(&"ALARM:5".to_string()), "{out:?}");
    }

    #[test]
    fn wcs_offsets_and_status_fields() {
        let mut d = dev(Flavor::Grbl11);
        send(&mut d, "G10 L2 P1 X-10 Y-20 Z-30");
        let s = status(&mut d);
        assert!(s.contains("WCO:-10.000,-20.000,-30.000"), "{s}");
        send(&mut d, "G0 X0 Y0 Z0");
        run(&mut d, 3.0);
        assert_eq!(d.machine_pos()[..3], [-10.0, -20.0, -30.0]);
        assert_eq!(d.work_pos()[..3], [0.0, 0.0, 0.0]);
        send(&mut d, "G10 L20 P1 X5");
        assert!((d.work_pos()[0] - 5.0).abs() < 1e-9);
        send(&mut d, "G92 Y1");
        assert!((d.work_pos()[1] - 1.0).abs() < 1e-9);
        // Status includes Ov on the report after WCO
        let s1 = status(&mut d);
        let s2 = status(&mut d);
        assert!(s1.contains("Ov:") || s2.contains("Ov:"), "{s1} {s2}");
    }

    #[test]
    fn spindle_and_coolant_show_in_accessories() {
        let mut d = dev(Flavor::Grbl11);
        send(&mut d, "M3 S12000");
        run(&mut d, 0.01);
        send(&mut d, "M8");
        run(&mut d, 0.01);
        let reports: Vec<String> = (0..3).map(|_| status(&mut d)).collect();
        assert!(reports.iter().any(|r| r.contains("A:SF")), "{reports:?}");
        assert!(reports[0].contains("FS:0,12000"));
    }

    #[test]
    fn arcs_in_all_planes_end_at_target() {
        for (plane, cmd) in [("G17", "G2 X-20 Y0 I-10 J0 F3000"), ("G18", "G2 X-20 Z0 I-10 K0 F3000"), ("G19", "G3 Y-20 Z0 J-10 K0 F3000")] {
            let mut d = dev(Flavor::Grbl11);
            send(&mut d, plane);
            d.receive(format!("{cmd}\n").as_bytes());
            let out = run(&mut d, 5.0);
            assert!(out.contains(&"ok".to_string()), "{plane}: {out:?}");
            let p = d.machine_pos();
            assert!(p.iter().take(3).any(|v| (v + 20.0).abs() < 1e-6), "{plane}: {p:?}");
        }
        let mut d = dev(Flavor::Grbl11);
        assert_eq!(send(&mut d, "G2 X-20 Y0 R5 F100"), vec!["error:34"]);
        assert_eq!(send(&mut d, "G2 X-20 Y0 F100"), vec!["error:35"]);
    }

    #[test]
    fn check_mode_parses_without_moving() {
        let mut d = dev(Flavor::Grbl11);
        assert_eq!(send(&mut d, "$C"), vec!["[MSG:Enabled]", "ok"]);
        assert_eq!(send(&mut d, "G0 X-50"), vec!["ok"]);
        // Check mode still validates: feed rate is undefined.
        assert_eq!(send(&mut d, "G1 X-10"), vec!["error:22"]);
        run(&mut d, 1.0);
        assert_eq!(d.machine_pos()[0], 0.0);
        let out = send(&mut d, "$C");
        assert_eq!(out[0], "[MSG:Disabled]");
        assert!(out.iter().any(|l| l.starts_with("Grbl")));
        assert_eq!(d.state_name(), "Idle");
    }

    #[test]
    fn legacy_09_flavor() {
        let mut d = VirtualGrbl::new(VirtualConfig::new(Flavor::Grbl09));
        let out = lines(&mut d);
        assert!(out.iter().any(|l| l == "Grbl 0.9j ['$' for help]"));
        assert_eq!(send(&mut d, "G1 X1"), vec!["error: Undefined feed rate"]);
        assert_eq!(send(&mut d, "$J=X1 F10"), vec!["error: Invalid statement"]);
        let s = status(&mut d);
        assert!(s.starts_with("<Idle,MPos:0.000,0.000,0.000,WPos:"), "{s}");
        let ss = send(&mut d, "$$");
        assert!(ss[0].contains("(step pulse, usec)"));
    }

    #[test]
    fn grblhal_flavor() {
        let mut d = VirtualGrbl::new(VirtualConfig::new(Flavor::GrblHal));
        let out = lines(&mut d);
        assert!(out.iter().any(|l| l.starts_with("GrblHAL 1.1f")));
        assert_eq!(send(&mut d, "M6 T2"), vec!["ok"]);
        let i = send(&mut d, "$I");
        assert!(i.contains(&"[FIRMWARE:grblHAL]".to_string()));
    }

    #[test]
    fn fault_injection() {
        let mut d = dev(Flavor::Grbl11);
        d.inject(Fault::ErrorOnNextLine(33));
        assert_eq!(send(&mut d, "G0 X-1"), vec!["error:33"]);
        d.inject(Fault::DropNextOk);
        d.receive(b"G4 P0\n");
        assert!(run(&mut d, 0.1).is_empty());
        d.inject(Fault::Alarm(1));
        let out = lines(&mut d);
        assert_eq!(out, vec!["ALARM:1", "[MSG:Reset to continue]"]);
        // Critical: lines are ignored until reset
        d.receive(b"$X\n");
        run(&mut d, 0.1);
        assert!(lines(&mut d).is_empty());
        d.receive(&[0x18]);
        assert_eq!(d.state_name(), "Alarm");
        d.inject(Fault::Disconnect);
        assert!(d.is_disconnected());
    }

    #[test]
    fn overrides_change_report_and_speed() {
        let mut d = dev(Flavor::Grbl11);
        d.receive(&[0x91, 0x91, 0x96]);
        let r1 = status(&mut d);
        let r2 = status(&mut d);
        assert!(r1.contains("Ov:120,50,100") || r2.contains("Ov:120,50,100"), "{r1} {r2}");
    }

    #[test]
    fn startup_lines_run_on_reset() {
        let mut d = dev(Flavor::Grbl11);
        assert_eq!(send(&mut d, "$N0=G55"), vec!["ok"]);
        d.receive(&[0x18]);
        let out = lines(&mut d);
        assert!(out.contains(&">G55:ok".to_string()), "{out:?}");
        let g = send(&mut d, "$G");
        assert!(g[0].contains("G55"));
    }
}
