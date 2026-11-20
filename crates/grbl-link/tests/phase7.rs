//! Phase 7 integration tests against the virtual GRBL device: guided tool
//! changes, start-from-line recovery lines and tracked commands.

use grbl_core::gcode_prep::{prepare, FirmwareCaps};
use grbl_link::{EventSink, JobMode, JobOptions, JobPhase, Link, LinkEvent, LinkOptions, ToolChangeMode};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use virtual_grbl::{Flavor, VirtualConfig, VirtualFactory};

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
    fn any<F: Fn(&LinkEvent) -> bool>(&self, pred: F) -> bool {
        self.events.lock().unwrap().iter().any(pred)
    }
    fn tx_lines(&self) -> Vec<String> {
        self.events.lock().unwrap().iter().filter_map(|e| if let LinkEvent::Tx { line, realtime: false, .. } = e { Some(line.clone()) } else { None }).collect()
    }
}

const T: Duration = Duration::from_secs(20);

fn ready() -> (Link, Arc<Collect>, Arc<VirtualFactory>) {
    let mut c = VirtualConfig::new(Flavor::Grbl11);
    c.boot_delay = 0.05;
    c.time_scale = 20.0;
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    let factory = Arc::new(VirtualFactory::new(c));
    link.connect(factory.clone(), LinkOptions { poll_hz: 20.0, ..LinkOptions::default() }).unwrap();
    sink.wait_for("offsets from $#", T, |e| matches!(e, LinkEvent::Controller { info } if info.offsets.contains_key("TLO")));
    sink.wait_for("idle", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state) == "Some(Idle)"));
    (link, sink, factory)
}

fn phase(p: JobPhase) -> impl Fn(&LinkEvent) -> bool {
    move |e| matches!(e, LinkEvent::Job { progress } if progress.phase == p)
}

#[test]
fn m6_pauses_for_a_guided_tool_change_and_continues() {
    let (link, sink, factory) = ready();
    let src = "G21 G90\nG1 X-20 F3000\nT2 M6\nG1 X-40\nM6\nG0 X0\n";
    let (lines, scan) = prepare(src, &FirmwareCaps::GRBL11);
    assert!(!scan.has_errors());
    link.start_job_with("tc.nc".into(), lines, JobMode::Run, JobOptions::default()).unwrap();

    let ev = sink.wait_for("tool change", T, phase(JobPhase::ToolChange));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    let tc = progress.tool_change.expect("tool change info");
    assert_eq!((tc.line, tc.tool), (3, Some(2)));
    assert_eq!(progress.current_line, 2, "everything before the M6 is acknowledged");

    // The UI moves the machine during the change and waits for each step.
    link.send_tracked("G0 Z-5", 7).unwrap();
    sink.wait_for("ack 7", T, |e| matches!(e, LinkEvent::CommandAck { id: 7, error: None, dropped: false, .. }));
    // Jogging is allowed during a tool change; settings writes are not.
    assert!(link.send_line("$110=100").is_err());
    link.tool_change_done().unwrap();

    // The bare M6 on line 5 pauses again (no T word).
    let ev = sink.wait_for("second tool change", T, |e| matches!(e, LinkEvent::Job { progress } if progress.phase == JobPhase::ToolChange && progress.tool_change.as_ref().is_some_and(|t| t.line == 5)));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    assert_eq!(progress.tool_change.unwrap().tool, None);
    link.tool_change_done().unwrap();
    let done = sink.wait_for("completed", T, phase(JobPhase::Completed));
    let LinkEvent::Job { progress } = done else { unreachable!() };
    assert_eq!(progress.error_count, 0, "M6 is never sent to GRBL 1.1");
    assert_eq!(factory.handle().unwrap().state_name(), "Idle");
    link.disconnect();
}

#[test]
fn ignore_strategy_skips_m6_without_pausing() {
    let (link, sink, _f) = ready();
    let (lines, _) = prepare("G21\nG1 X-5 F3000\nT3 M6\nG1 X-10\n", &FirmwareCaps::GRBL11);
    link.start_job_with("skip.nc".into(), lines, JobMode::Run, JobOptions { tool_change: ToolChangeMode::Skip, ..JobOptions::default() }).unwrap();
    let done = sink.wait_for("completed", T, phase(JobPhase::Completed));
    let LinkEvent::Job { progress } = done else { unreachable!() };
    assert_eq!(progress.error_count, 0);
    assert!(!sink.any(phase(JobPhase::ToolChange)));
    link.disconnect();
}

#[test]
fn start_from_line_sends_recovery_lines_first() {
    let (link, sink, factory) = ready();
    let src = "G21 G90\nG1 X-10 F3000\nG1 X-20\nG1 X-30 Y-5\nG0 X0 Y0\n";
    let (lines, _) = prepare(src, &FirmwareCaps::GRBL11);
    let from: Vec<_> = lines.into_iter().filter(|l| l.source_line >= 4).collect();
    let prelude = vec!["G21 G90".to_string(), "G53 G0 Z-1".to_string(), "G0 X-20 Y0".to_string(), "G1 F3000".to_string()];
    link.start_job_with("from.nc".into(), from, JobMode::Run, JobOptions { prelude, ..JobOptions::default() }).unwrap();
    let done = sink.wait_for("completed", T, phase(JobPhase::Completed));
    let LinkEvent::Job { progress } = done else { unreachable!() };
    assert_eq!(progress.prelude_lines, 4);
    assert_eq!(progress.error_count, 0);
    assert_eq!((progress.total, progress.acked), (2, 2), "only lines 4 and 5 are job lines");
    let tx = sink.tx_lines();
    assert_eq!(&tx[tx.len() - 4..], &["G21 G90", "G53 G0 Z-1", "G0 X-20 Y0", "G1 F3000"], "recovery lines in order");
    let p = factory.handle().unwrap().machine_pos();
    assert!(p[0].abs() < 1e-6 && p[1].abs() < 1e-6);
    link.disconnect();
}

#[test]
fn a_rejected_recovery_line_stops_the_start() {
    let (link, sink, _f) = ready();
    let (lines, _) = prepare("G21\nG1 X-10 F3000\n", &FirmwareCaps::GRBL11);
    // G2 without a radius/offset is rejected; the line after it must never be sent.
    let prelude = vec!["G21 G90".to_string(), "G2 X-5".to_string(), "G0 X-50".to_string()];
    link.start_job_with("bad.nc".into(), lines, JobMode::Run, JobOptions { prelude, ..JobOptions::default() }).unwrap();
    let ev = sink.wait_for("failed", T, phase(JobPhase::Failed));
    let LinkEvent::Job { progress } = ev else { unreachable!() };
    assert!(progress.message.unwrap().contains("recovery line"));
    assert!(!sink.tx_lines().iter().any(|l| l == "G0 X-50"));
    assert_eq!(progress.sent, 0, "no job line was sent");
    link.disconnect();
}

#[test]
fn tracked_commands_report_errors_and_drops() {
    let (link, sink, _f) = ready();
    link.send_tracked("G2 X1", 1).unwrap();
    sink.wait_for("error ack", T, |e| matches!(e, LinkEvent::CommandAck { id: 1, error: Some(_), dropped: false, .. }));
    // A long move, then a reset: the queued tracked line is reported as dropped.
    link.send_line("G1 X-150 F600").unwrap();
    link.send_tracked("G4 P0", 2).unwrap();
    sink.wait_for("moving", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state) == "Some(Run)"));
    link.send_realtime(0x18).unwrap();
    sink.wait_for("dropped", T, |e| matches!(e, LinkEvent::CommandAck { id: 2, dropped: true, .. }));
    link.disconnect();
}
