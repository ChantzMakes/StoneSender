//! `$$` settings table: defaults, metadata and formatting.

use std::collections::BTreeMap;

/// GRBL 1.1 `defaults.h` (generic) values.
pub fn default_settings(axes: usize) -> BTreeMap<u16, f64> {
    let mut s = BTreeMap::new();
    for (k, v) in [
        (0, 10.0),
        (1, 25.0),
        (2, 0.0),
        (3, 0.0),
        (4, 0.0),
        (5, 0.0),
        (6, 0.0),
        (10, 1.0),
        (11, 0.010),
        (12, 0.002),
        (13, 0.0),
        (20, 0.0),
        (21, 0.0),
        (22, 0.0),
        (23, 0.0),
        (24, 25.0),
        (25, 500.0),
        (26, 250.0),
        (27, 1.0),
        (30, 1000.0),
        (31, 0.0),
        (32, 0.0),
    ] {
        s.insert(k, v);
    }
    for axis in 0..axes as u16 {
        s.insert(100 + axis, 250.0);
        s.insert(110 + axis, 500.0);
        s.insert(120 + axis, 10.0);
        s.insert(130 + axis, 200.0);
    }
    s
}

/// Settings stored as integers (masks, booleans, counts).
pub fn is_integer_setting(id: u16) -> bool {
    matches!(id, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 10 | 13 | 20 | 21 | 22 | 23 | 26 | 32)
}

pub fn format_value(id: u16, v: f64) -> String {
    if is_integer_setting(id) {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.3}")
    }
}

/// GRBL 0.9 printed a short description after each value.
pub fn legacy_comment(id: u16) -> &'static str {
    match id {
        0 => "step pulse, usec",
        1 => "step idle delay, msec",
        2 => "step port invert mask",
        3 => "dir port invert mask",
        4 => "step enable invert, bool",
        5 => "limit pins invert, bool",
        6 => "probe pin invert, bool",
        10 => "status report mask",
        11 => "junction deviation, mm",
        12 => "arc tolerance, mm",
        13 => "report inches, bool",
        20 => "soft limits, bool",
        21 => "hard limits, bool",
        22 => "homing cycle, bool",
        23 => "homing dir invert mask",
        24 => "homing feed, mm/min",
        25 => "homing seek, mm/min",
        26 => "homing debounce, msec",
        27 => "homing pull-off, mm",
        100..=103 => "step/mm",
        110..=113 => "max rate, mm/min",
        120..=123 => "accel, mm/sec^2",
        130..=133 => "max travel, mm",
        _ => "setting",
    }
}
