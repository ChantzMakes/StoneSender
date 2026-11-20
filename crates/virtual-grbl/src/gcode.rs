//! Minimal line cleaning and tokenising, matching GRBL's input filter.
//! (The app's full interpreter lives in the frontend from Phase 3; this one
//! only needs to be faithful enough to emulate the controller.)

/// GRBL status codes used by the emulator (subset of `report.h`).
pub mod err {
    pub const EXPECTED_COMMAND_LETTER: u16 = 1;
    pub const BAD_NUMBER_FORMAT: u16 = 2;
    pub const INVALID_STATEMENT: u16 = 3;
    pub const NEGATIVE_VALUE: u16 = 4;
    pub const SETTING_DISABLED: u16 = 5;
    pub const SETTING_STEP_PULSE_MIN: u16 = 6;
    pub const IDLE_ERROR: u16 = 8;
    pub const SYSTEM_GC_LOCK: u16 = 9;
    pub const SOFT_LIMIT_ERROR: u16 = 10;
    pub const OVERFLOW: u16 = 11;
    pub const TRAVEL_EXCEEDED: u16 = 15;
    pub const INVALID_JOG_COMMAND: u16 = 16;
    pub const UNSUPPORTED_COMMAND: u16 = 20;
    pub const MODAL_GROUP_VIOLATION: u16 = 21;
    pub const UNDEFINED_FEED_RATE: u16 = 22;
    pub const COMMAND_VALUE_NOT_INTEGER: u16 = 23;
    pub const AXIS_COMMAND_CONFLICT: u16 = 24;
    pub const WORD_REPEATED: u16 = 25;
    pub const NO_AXIS_WORDS: u16 = 26;
    pub const INVALID_LINE_NUMBER: u16 = 27;
    pub const VALUE_WORD_MISSING: u16 = 28;
    pub const G53_INVALID_MOTION_MODE: u16 = 30;
    pub const AXIS_WORDS_EXIST: u16 = 31;
    pub const NO_AXIS_WORDS_IN_PLANE: u16 = 32;
    pub const INVALID_TARGET: u16 = 33;
    pub const ARC_RADIUS_ERROR: u16 = 34;
    pub const NO_OFFSETS_IN_PLANE: u16 = 35;
    pub const MAX_VALUE_EXCEEDED: u16 = 38;
}

/// Strip whitespace and comments, upper-case. Mirrors `protocol.c`'s filter.
pub fn clean_line(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_paren = false;
    for &b in raw {
        let c = b as char;
        if in_paren {
            if c == ')' {
                in_paren = false;
            }
            continue;
        }
        match c {
            '(' => in_paren = true,
            ';' => break,
            c if c.is_whitespace() || (c as u32) < 0x20 => {}
            '%' => {}
            c => out.push(c.to_ascii_uppercase()),
        }
    }
    out
}

/// Tokenise a cleaned line into `(letter, value)` words.
pub fn tokenize(line: &str) -> Result<Vec<(char, f64)>, u16> {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut words = Vec::new();
    while i < bytes.len() {
        let letter = bytes[i] as char;
        if !letter.is_ascii_alphabetic() {
            return Err(err::EXPECTED_COMMAND_LETTER);
        }
        i += 1;
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.' || bytes[i] == b'-' || bytes[i] == b'+') {
            i += 1;
        }
        let num = &line[start..i];
        let value: f64 = num.parse().map_err(|_| err::BAD_NUMBER_FORMAT)?;
        words.push((letter, value));
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_and_tokenises() {
        assert_eq!(clean_line(b"g1 x10 (comment) y-2.5 ; trailing"), "G1X10Y-2.5");
        let w = tokenize("G1X10Y-.5F300").unwrap();
        assert_eq!(w, vec![('G', 1.0), ('X', 10.0), ('Y', -0.5), ('F', 300.0)]);
        assert_eq!(tokenize("G1X1.2.3"), Err(err::BAD_NUMBER_FORMAT));
        assert_eq!(tokenize("X"), Err(err::BAD_NUMBER_FORMAT));
        assert_eq!(tokenize("1G1"), Err(err::EXPECTED_COMMAND_LETTER));
    }
}
