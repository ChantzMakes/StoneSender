//! Integration tests: the link layer against the virtual GRBL device, for
//! every preset profile, including fault injection.

use grbl_core::profile::MachineProfile;
use grbl_core::protocol::GrblLine;
use grbl_core::transport::TransportFactory;
use grbl_link::{EventSink, Link, LinkEvent, LinkOptions, LinkState};
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
        let mut seen = 0;
        let mut guard = self.events.lock().unwrap();
        loop {
            if let Some(e) = guard[seen..].iter().find(|e| pred(e)) {
                return e.clone();
            }
            seen = guard.len();
            let left = timeout.checked_sub(start.elapsed()).unwrap_or_else(|| panic!("timed out waiting for {what}"));
            guard = self.cv.wait_timeout(guard, left).unwrap().0;
        }
    }
    fn clear(&self) {
        self.events.lock().unwrap().clear();
    }
    fn rx_lines(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                LinkEvent::Rx { line, .. } => Some(line.clone()),
                _ => None,
            })
            .collect()
    }
}

fn fast_opts() -> LinkOptions {
    LinkOptions {
        poll_hz: 10.0,
        reconnect_interval: Duration::from_millis(100),
        reconnect_attempts: 3,
        ..LinkOptions::default()
    }
}

fn virtual_factory(mut cfg: VirtualConfig) -> Arc<VirtualFactory> {
    cfg.boot_delay = 0.05;
    Arc::new(VirtualFactory::new(cfg))
}

const T: Duration = Duration::from_secs(5);

#[test]
fn connects_detects_firmware_and_polls_status() {
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    let factory = virtual_factory(VirtualConfig::new(Flavor::Grbl11));
    link.connect(factory.clone(), fast_opts()).unwrap();
    sink.wait_for("firmware", T, |e| matches!(e, LinkEvent::Firmware { info } if info.version == "1.1h"));
    sink.wait_for("status", T, |e| matches!(e, LinkEvent::Status { .. }));
    assert_eq!(link.snapshot().state, LinkState::Connected);
    assert!(link.snapshot().firmware.is_some());

    link.send_line("$$").unwrap();
    sink.wait_for("$130", T, |e| matches!(e, LinkEvent::Rx { parsed: GrblLine::Setting { id: 130, .. }, .. }));
    sink.wait_for("ok", T, |e| matches!(e, LinkEvent::Rx { parsed: GrblLine::Ok, .. }));

    link.disconnect();
    assert_eq!(link.snapshot().state, LinkState::Disconnected);
    assert!(link.send_line("$$").is_err());
}

#[test]
fn legacy_firmware_is_flagged() {
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    link.connect(virtual_factory(VirtualConfig::new(Flavor::Grbl09)), fast_opts()).unwrap();
    let ev = sink.wait_for("firmware", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    match ev {
        LinkEvent::Firmware { info } => {
            assert!(info.legacy);
            assert!(!info.warnings.is_empty());
        }
        _ => unreachable!(),
    }
    // 0.9 status reports still drive the DRO
    sink.wait_for("status", T, |e| matches!(e, LinkEvent::Status { status, .. } if status.mpos.len() == 3));
    link.disconnect();
}

#[test]
fn every_preset_profile_round_trips_its_settings() {
    let dir = format!("{}/../../presets", env!("CARGO_MANIFEST_DIR"));
    let mut count = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        count += 1;
        let profile = MachineProfile::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let flavor = if profile.controller.firmware == grbl_core::profile::FirmwarePreference::Grblhal { Flavor::GrblHal } else { Flavor::Grbl11 };
        let sink = Arc::new(Collect::default());
        let link = Link::new(sink.clone());
        link.connect(virtual_factory(VirtualConfig::from_profile(&profile, flavor)), fast_opts()).unwrap();
        sink.wait_for("firmware", T, |e| matches!(e, LinkEvent::Firmware { .. }));
        link.send_line("$X").unwrap();
        link.send_line("$$").unwrap();
        // two oks: $X and $$
        let start = Instant::now();
        while sink.rx_lines().iter().filter(|l| *l == "ok").count() < 2 {
            assert!(start.elapsed() < T, "{path:?}: no ok");
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut seen = std::collections::BTreeMap::new();
        for e in sink.events.lock().unwrap().iter() {
            if let LinkEvent::Rx { parsed: GrblLine::Setting { id, value }, .. } = e {
                seen.insert(*id, value.parse::<f64>().unwrap());
            }
        }
        for (id, expected) in profile.to_grbl_settings() {
            let got = seen.get(&id).unwrap_or_else(|| panic!("{path:?}: ${id} missing"));
            assert!((got - expected).abs() < 0.001, "{path:?}: ${id} = {got}, expected {expected}");
        }
        // Jog a little and see the position move in status reports.
        link.send_line("$J=G91 X-5 F1000").unwrap();
        sink.wait_for("moved", T, |e| matches!(e, LinkEvent::Status { status, .. } if status.mpos.first().copied().unwrap_or(0.0) < -4.99));
        link.disconnect();
    }
    assert!(count >= 8, "expected all presets, found {count}");
}

#[test]
fn auto_reconnects_after_disconnect_without_resending() {
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    let factory = virtual_factory(VirtualConfig::new(Flavor::Grbl11));
    link.connect(factory.clone(), fast_opts()).unwrap();
    sink.wait_for("firmware", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    factory.handle().unwrap().inject(Fault::Disconnect);
    sink.wait_for("lost", T, |e| matches!(e, LinkEvent::State { state: LinkState::Lost, .. }));
    sink.wait_for("reconnecting", T, |e| matches!(e, LinkEvent::State { state: LinkState::Reconnecting, .. }));
    sink.clear();
    sink.wait_for("connected", T, |e| matches!(e, LinkEvent::State { state: LinkState::Connected, .. }));
    sink.wait_for("banner after reconnect", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    let tx: Vec<_> = sink.events.lock().unwrap().iter().filter(|e| matches!(e, LinkEvent::Tx { realtime: false, .. })).cloned().collect();
    assert!(tx.is_empty(), "nothing may be re-sent after reconnect: {tx:?}");
    link.disconnect();
}

#[test]
fn gives_up_when_device_stays_gone() {
    struct Dead;
    impl TransportFactory for Dead {
        fn open(&self) -> std::io::Result<grbl_core::transport::TransportPair> {
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "gone"))
        }
        fn describe(&self) -> String {
            "dead".into()
        }
    }
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    let err = link.connect(Arc::new(Dead), fast_opts()).unwrap_err();
    assert!(matches!(err, grbl_link::LinkError::Open(_)));
    assert_eq!(link.snapshot().state, LinkState::Disconnected);
}

#[test]
fn soft_reset_flushes_pending_queue() {
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    link.connect(virtual_factory(VirtualConfig::new(Flavor::Grbl11)), fast_opts()).unwrap();
    sink.wait_for("firmware", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    for _ in 0..5 {
        link.send_line("G4 P0.5").unwrap();
    }
    sink.wait_for("first dwell sent", T, |e| matches!(e, LinkEvent::Tx { line, .. } if line == "G4 P0.5"));
    let count = || sink.events.lock().unwrap().iter().filter(|e| matches!(e, LinkEvent::Tx { line, .. } if line == "G4 P0.5")).count();
    link.send_realtime(0x18).unwrap();
    // Once send_realtime returns, the reset byte is out and the queue flushed.
    let sent_before = count();
    sink.wait_for("dropped", T, |e| matches!(e, LinkEvent::Queue { dropped, .. } if *dropped > 0));
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(count(), sent_before, "unacknowledged lines must not be (re)sent after a reset");
    link.disconnect();
}

#[test]
fn feed_hold_and_resume_over_the_link() {
    let sink = Arc::new(Collect::default());
    let link = Link::new(sink.clone());
    let mut cfg = VirtualConfig::new(Flavor::Grbl11);
    cfg.settings.insert(110, 3000.0);
    cfg.settings.insert(120, 200.0);
    link.connect(virtual_factory(cfg), fast_opts()).unwrap();
    sink.wait_for("firmware", T, |e| matches!(e, LinkEvent::Firmware { .. }));
    link.send_line("G1 X-40 F3000").unwrap();
    sink.wait_for("run", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state).contains("Run")));
    link.send_realtime(b'!').unwrap();
    sink.wait_for("hold", T, |e| matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state).contains("Hold(0)")));
    link.send_realtime(b'~').unwrap();
    sink.wait_for("idle at target", T, |e| {
        matches!(e, LinkEvent::Status { status, .. } if format!("{:?}", status.state).contains("Idle") && (status.mpos[0] + 40.0).abs() < 1e-6)
    });
    link.disconnect();
}
