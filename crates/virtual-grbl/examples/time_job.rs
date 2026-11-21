//! Stream a G-code file through the emulator (character counting, like the
//! app) and print how long the virtual machine takes to run it.
//!
//!   cargo run -p virtual-grbl --example time_job -- <profile.json> <job.nc> [grbl11|grblhal]
//!
//! Used by `scripts/gen-timing-fixtures.mjs` to cross-check the TypeScript
//! planner's time estimate against an independent implementation.

use grbl_core::gcode_prep::{prepare, FirmwareCaps};
use grbl_core::profile::MachineProfile;
use std::collections::VecDeque;
use virtual_grbl::{Flavor, VirtualConfig, VirtualGrbl};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: time_job <profile.json> <job.nc> [grbl11|grblhal]");
        std::process::exit(2);
    }
    let profile = MachineProfile::from_json(&std::fs::read_to_string(&args[1]).expect("read profile")).expect("valid profile");
    let text = std::fs::read_to_string(&args[2]).expect("read job");
    let flavor = match args.get(3).map(String::as_str) {
        Some("grblhal") => Flavor::GrblHal,
        _ => Flavor::Grbl11,
    };
    let caps = if flavor == Flavor::GrblHal { FirmwareCaps::GRBLHAL } else { FirmwareCaps::GRBL11 };
    let (lines, _) = prepare(&text, &caps);

    let mut cfg = VirtualConfig::from_profile(&profile, flavor);
    cfg.boot_delay = 0.0;
    // No limits/homing so the sample jobs (which start at 0,0,0) run as written.
    cfg.settings.insert(20, 0.0);
    cfg.settings.insert(21, 0.0);
    cfg.settings.insert(22, 0.0);
    let capacity = cfg.rx_buffer_size - 1;
    let mut dev = VirtualGrbl::new(cfg);
    dev.take_output();

    let dt = 0.001;
    let mut t = 0.0_f64;
    let mut next = 0;
    let mut in_flight: VecDeque<usize> = VecDeque::new();
    let mut acked = 0;
    let mut errors = 0;
    let mut pending = String::new();
    loop {
        while next < lines.len() {
            let len = lines.text(next).len() + 1;
            if in_flight.iter().sum::<usize>() + len > capacity {
                break;
            }
            dev.receive(format!("{}\n", lines.text(next)).as_bytes());
            in_flight.push_back(len);
            next += 1;
        }
        dev.step(dt);
        t += dt;
        pending.push_str(&String::from_utf8_lossy(&dev.take_output()));
        while let Some(pos) = pending.find('\n') {
            let line: String = pending.drain(..=pos).collect();
            let line = line.trim();
            if line == "ok" || line.starts_with("error") {
                in_flight.pop_front();
                acked += 1;
                if line.starts_with("error") {
                    errors += 1;
                }
            }
        }
        if acked == lines.len() && dev.state_name() == "Idle" {
            break;
        }
        if t > 24.0 * 3600.0 {
            eprintln!("gave up after a simulated day");
            std::process::exit(1);
        }
    }
    println!("{{\"seconds\": {t:.3}, \"lines\": {}, \"errors\": {errors}}}", lines.len());
}
