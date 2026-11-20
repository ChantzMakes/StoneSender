//! Phase 2 integration tests: streaming, job control, jogging and controller
//! info, all against the virtual GRBL device.

use grbl_core::gcode_prep::{prepare, FirmwareCaps};
use grbl_link::{EventSink, JobMode, JobPhase, Link, LinkEvent, LinkOptions, LinkState};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use virtual_grbl::{Fault, Flavor, VirtualConfig, VirtualFactory};

#[derive(Default)]
struct Collect {
    events: Mutex<Vec<LinkEvent>>,
    cv: Condvar,
}

impl EventSink for Collect {
    fn emit(&self, event: LinkEvent) {
        self.events.lock().unwrap().push(event);
        self.cv.notify_all();
    }
}

impl Collect {
    fn wait_for<F: Fn(&LinkEvent) -> bool>(&self, what: &str, timeout: Duration, pred: F) -> LinkEvent {
        let start = Instant::now();
        let mut guard = self.events.lock().unwrap();
        loop {
            if let Some(e) = guard.iter().find(|e| pred(e)) {
                return e.clone();
            }
            let left = timeout.checked_sub(start.elapsed()).unwrap_or_else(|| {
                let tail: Vec<String> = guard.iter().rev().take(15).map(|e| format!("{e:?}")).collect();
                panic!("timed out waiting for {what}; last events:\n{}", tail.join("\n"))
            });
            guard = self.cv.wait_timeout(guard, left).unwrap().0;
        }
    }
    fn clear(&self) {
        self.events.lock().unwrap().clear();
    }
    fn any<F: Fn(&LinkEvent) -> bool>(&self, pred: F) -> bool {
        self.events.lock().unwrap().iter().any(pred)
    }
}

const T: Duration = Duration::from_secs(20);

fn cfg(flavor: Flavor, scale: f64) -> VirtualConfig {
    let mut c = VirtualConfig::new(flavor);
    c.boot_delay = 0.05;
    c.time_scale = scale;
    for (k, v) in [(110, 6000.0), (111, 6000.0), (112, 2000.0), (120, 800.0), (121, 800.0), (122, 400.0)] {
        c.settings.insert(k, v);
    }
    c
}

fn opts(char_counting: bool) -> LinkOptions {
    LinkOptions { poll_hz: 20.0, char_counting, reconnect_interval: Duration::from_millis(100), reconnect_attempts: 2, ..LinkOptions::default() }
}

/// Connect and wait until the identify queries ($I $$ $G $#) are done.
fn ready(c: VirtualConfig, o: LinkOptions) -> (Link, Arc<Collect>, Arc<VirtualFactory>) {
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    let factory = Arc::new(VirtualFactory::new(c));
    link.connect(factory.clone(), o).unwrap();
    sink.wait_for("offsets from $#", T, |e| matches!(e, LinkEvent::Controller { info } if info.offsets.contains_key("TLO")));
    sink.wait_for("idle status", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state) == "Some(Idle)"));
    (link, sink, factory)
}

fn job_phase(sink: &Collect, phase: JobPhase) -> impl Fn(&LinkEvent) -> bool + '_ {
    let _ = sink;
    move |e| matches!(e, LinkEvent::Job { progress } if progress.phase == phase)
}

fn square_job(loops: usize) -> String {
    let mut s = String::from("G21 G90 G94\nG1 F6000\n");
    for i in 0..loops {
        let d = (i % 5) as f64 + 1.0;
        s.push_str(&format!("G1 X-{d}.000 Y-0.500 (side a)\nG1 X-{d}.000 Y-{d}.500\nG1 X-0.250 Y-{d}.500\nG1 X-0.250 Y-0.500\n"));
    }
    s.push_str("G0 X0 Y0\nM30\n");
    s
}

#[test]
fn character_counting_streams_a_job_without_overflowing_the_rx_buffer() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 40.0), opts(true));
    let (lines, scan) = prepare(&square_job(100), &FirmwareCaps::GRBL11);
    assert!(!scan.has_errors());
    let total = lines.len();
    link.start_job("square.nc".into(), lines, JobMode::Run).unwrap();
    // While running, interactive commands are refused.
    sink.wait_for("running", T, job_phase(&sink, JobPhase::Running));
    assert!(link.send_line("G0 X1").is_err());
    let done = sink.wait_for("completed", Duration::from_secs(60), job_phase(&sink, JobPhase::Completed));
    let LinkEvent::Job { progress } = done else { unreachable!() };
    assert_eq!(progress.acked, total);
    assert_eq!(progress.error_count, 0);
    let stats = factory.handle().unwrap().stats();
    assert_eq!(stats.rx_overflows, 0, "streamer overflowed GRBL's RX buffer");
    assert!(stats.max_rx_used > 64, "character counting should fill the buffer (max used {})", stats.max_rx_used);
    assert!(stats.max_rx_used <= 127);
    let p = factory.handle().unwrap().machine_pos();
    assert!(p[0].abs() < 1e-6 && p[1].abs() < 1e-6);
    link.disconnect();
}

#[test]
fn send_response_mode_keeps_one_line_in_the_buffer() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 40.0), opts(false));
    let (lines, _) = prepare(&square_job(10), &FirmwareCaps::GRBL11);
    link.start_job("sr.nc".into(), lines, JobMode::Run).unwrap();
    sink.wait_for("completed", T, job_phase(&sink, JobPhase::Completed));
    let stats = factory.handle().unwrap().stats();
    assert_eq!(stats.rx_overflows, 0);
    assert!(stats.max_rx_used <= 32, "max used {}", stats.max_rx_used);
    link.disconnect();
}

#[test]
fn error_mid_job_pauses_with_feed_hold_and_can_continue() {
    let (link, sink, _f) = ready(cfg(Flavor::Grbl11, 20.0), opts(true));
    let src = "G21 G90\nG1 X-20 F3000\nM6 T2\nG1 X-40\nG1 X-60\nG0 X0\n";
    let (lines, _) = prepare(src, &FirmwareCaps::GRBL11);
    link.start_job("err.nc".into(), lines, JobMode::Run).unwrap();
    let ev = sink.wait_for("paused on error", T, job_phase(&sink, JobPhase::PausedOnError));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    assert_eq!(progress.errors[0].source_line, 3);
    assert_eq!(progress.errors[0].code, Some(20));
    sink.wait_for("feed hold sent", T, |e| matches!(e, LinkEvent::Tx { line, .. } if line.starts_with('!')));
    sink.wait_for("hold", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state).contains("Hold(0)")));
    // read-only queries are allowed while paused, motion is not
    link.send_line("$G").unwrap();
    assert!(link.send_line("G0 X5").is_err());
    link.resume_job().unwrap();
    let done = sink.wait_for("completed", T, job_phase(&sink, JobPhase::Completed));
    let LinkEvent::Job { progress } = done else { unreachable!() };
    assert_eq!(progress.error_count, 1);
    link.disconnect();
}

#[test]
fn stop_holds_then_resets_without_losing_position() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 2.0), opts(true));
    let (lines, _) = prepare("G21 G90\nG1 X-150 F3000\nG1 Y-150\nG0 X0 Y0\n", &FirmwareCaps::GRBL11);
    link.start_job("long.nc".into(), lines, JobMode::Run).unwrap();
    sink.wait_for("moving", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state) == "Some(Run)"));
    link.stop_job().unwrap();
    sink.wait_for("stopped", T, job_phase(&sink, JobPhase::Stopped));
    assert!(sink.any(|e| matches!(e, LinkEvent::Tx { line, .. } if line.starts_with("Ctrl-X"))));
    assert!(!sink.any(|e| matches!(e, LinkEvent::Rx { line, .. } if line == "ALARM:3")), "reset after the hold must not raise ALARM:3");
    assert_eq!(factory.handle().unwrap().state_name(), "Idle");
    link.disconnect();
}

#[test]
fn disconnect_mid_job_aborts_and_never_resends() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 2.0), opts(true));
    let (lines, _) = prepare(&square_job(50), &FirmwareCaps::GRBL11);
    link.start_job("dc.nc".into(), lines, JobMode::Run).unwrap();
    sink.wait_for("running", T, job_phase(&sink, JobPhase::Running));
    std::thread::sleep(Duration::from_millis(200));
    factory.handle().unwrap().inject(Fault::Disconnect);
    let ev = sink.wait_for("failed", T, job_phase(&sink, JobPhase::Failed));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    assert!(progress.message.unwrap().contains("connection lost"));
    sink.wait_for("reconnected", T, |e| matches!(e, LinkEvent::State { state: LinkState::Connected, message: Some(_), .. }));
    sink.wait_for("banner", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    std::thread::sleep(Duration::from_millis(300));
    // The new controller instance must not have received any job lines.
    assert_eq!(factory.handle().unwrap().stats().lines_processed, 4, "only the identify queries ($I $$ $G $#) may be sent");
    link.disconnect();
}

#[test]
fn alarm_mid_job_aborts() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 2.0), opts(true));
    let (lines, _) = prepare(&square_job(50), &FirmwareCaps::GRBL11);
    link.start_job("al.nc".into(), lines, JobMode::Run).unwrap();
    sink.wait_for("running", T, job_phase(&sink, JobPhase::Running));
    factory.handle().unwrap().inject(Fault::Alarm(1));
    let ev = sink.wait_for("failed", T, job_phase(&sink, JobPhase::Failed));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    assert!(progress.message.unwrap().contains("ALARM:1"));
    link.disconnect();
}

#[test]
fn check_mode_reports_errors_without_moving() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 20.0), opts(true));
    let (lines, _) = prepare("G21 G90\nG1 X-50 F1000\nG1 X-10 Y-10 Z-1 R5\nM6\nG0 X0\n", &FirmwareCaps::GRBL11);
    link.start_job("check.nc".into(), lines, JobMode::Check).unwrap();
    let ev = sink.wait_for("completed", T, job_phase(&sink, JobPhase::Completed));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    assert_eq!(progress.mode, JobMode::Check);
    assert_eq!(progress.error_count, 1, "{:?}", progress.errors);
    assert_eq!(progress.errors[0].source_line, 4);
    assert_eq!(factory.handle().unwrap().machine_pos()[0], 0.0);
    sink.wait_for("idle again after $C", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    link.disconnect();
}

#[test]
fn continuous_jog_moves_while_held_and_stops_on_release() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 1.0), opts(true));
    link.jog_start([-1.0, 0.0, 0.0], 3000.0, 800.0).unwrap();
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(60));
        link.jog_heartbeat();
    }
    link.jog_stop();
    sink.wait_for("jog cancel", T, |e| matches!(e, LinkEvent::Tx { line, .. } if line == "Jog cancel"));
    let h = factory.handle().unwrap();
    let start = Instant::now();
    while h.state_name() != "Idle" && start.elapsed() < T {
        std::thread::sleep(Duration::from_millis(10));
    }
    let x = h.machine_pos()[0];
    // ~0.5 s at 50 mm/s
    assert!(x < -10.0 && x > -45.0, "x = {x}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(h.machine_pos()[0], x, "no motion after the cancel");
    assert_eq!(h.stats().rx_overflows, 0);
    link.disconnect();
}

#[test]
fn jog_watchdog_stops_when_heartbeats_stop() {
    let (link, sink, factory) = ready(cfg(Flavor::Grbl11, 1.0), opts(true));
    link.jog_start([0.0, -1.0, 0.0], 2000.0, 800.0).unwrap();
    sink.wait_for("jog cancel", Duration::from_secs(3), |e| matches!(e, LinkEvent::Tx { line, .. } if line == "Jog cancel"));
    let h = factory.handle().unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let y = h.machine_pos()[1];
    assert!(y < -1.0 && y > -25.0, "y = {y}");
    link.disconnect();
}

#[test]
fn jogging_into_soft_limits_stops_cleanly() {
    let mut c = cfg(Flavor::Grbl11, 1.0);
    c.settings.insert(22, 1.0);
    c.settings.insert(20, 1.0);
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    link.connect(Arc::new(VirtualFactory::new(c)), opts(true)).unwrap();
    sink.wait_for("offsets", T, |e| matches!(e, LinkEvent::Controller { info } if info.offsets.contains_key("TLO")));
    // Boots in alarm (homing enabled): jogging is refused.
    std::thread::sleep(Duration::from_millis(100));
    assert!(link.jog_start([1.0, 0.0, 0.0], 1000.0, 500.0).is_err());
    link.send_line("$X").unwrap();
    sink.wait_for("idle", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state) == "Some(Idle)"));
    link.jog_start([1.0, 0.0, 0.0], 1000.0, 500.0).unwrap(); // +X is outside [-travel, 0]
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(50));
        link.jog_heartbeat();
    }
    sink.wait_for("error:15", T, |e| matches!(e, LinkEvent::Rx { line, .. } if line == "error:15"));
    sink.wait_for("jog cancel", T, |e| matches!(e, LinkEvent::Tx { line, .. } if line == "Jog cancel"));
    link.disconnect();
}

#[test]
fn grblhal_rx_buffer_is_detected_from_dollar_i() {
    let (link, sink, _f) = ready(cfg(Flavor::GrblHal, 1.0), opts(true));
    // `ready` waited for $# (the last identify query), so everything is in.
    let info = link.snapshot().controller;
    assert_eq!(info.rx_buffer, 1024);
    assert!(info.build.grblhal);
    assert!(info.settings.contains_key(&110));
    assert!(info.parser_state.iter().any(|w| w == "G54"));
    assert_eq!(link.snapshot().firmware.unwrap().kind, grbl_core::firmware::FirmwareKind::Grblhal);
    sink.clear();
    link.refresh_controller().unwrap();
    sink.wait_for("refreshed", T, |e| matches!(e, LinkEvent::Controller { .. }));
    link.disconnect();
}

#[test]
fn job_refused_unless_idle() {
    let mut c = cfg(Flavor::Grbl11, 1.0);
    c.settings.insert(22, 1.0); // boots in Alarm
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    link.connect(Arc::new(VirtualFactory::new(c)), opts(true)).unwrap();
    sink.wait_for("alarm status", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state) == "Some(Alarm)"));
    let (lines, _) = prepare("G0 X-1\n", &FirmwareCaps::GRBL11);
    let err = link.start_job("x".into(), lines, JobMode::Run).unwrap_err();
    assert!(err.to_string().contains("Idle"), "{err}");
    link.disconnect();
}
