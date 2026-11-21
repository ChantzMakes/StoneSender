//! Performance pass (Phase 8): `cargo test --release -p grbl-core --test perf -- --ignored --nocapture`
//! after `node scripts/gen-stress.mjs 5000000`.
use grbl_core::gcode_prep::{prepare, FirmwareCaps};
use std::time::Instant;

#[test]
#[ignore]
fn prepare_stress_file() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/gcode/stress.nc");
    let Ok(text) = std::fs::read_to_string(path) else {
        eprintln!("no stress file; run node scripts/gen-stress.mjs");
        return;
    };
    let t = Instant::now();
    let (lines, scan) = prepare(&text, &FirmwareCaps::GRBL11);
    eprintln!("prepare {} lines ({} stored): {:?}", scan.lines, lines.len(), t.elapsed());
}
