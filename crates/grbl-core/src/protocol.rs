//! Classification of every kind of line a GRBL / grblHAL controller sends.

use crate::firmware::{parse_welcome, FirmwareInfo};
use crate::status::{parse_status, StatusReport};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GrblLine {
    Ok,
    /// `error:N` (1.1+) — `code` is `None` for GRBL 0.9 text errors.
    Error { code: Option<u16>, text: String },
    /// `ALARM:N` (1.1+) — `code` is `None` for GRBL 0.9 text alarms.
    Alarm { code: Option<u16>, text: String },
    Status { report: StatusReport },
    Welcome { info: FirmwareInfo },
    /// `$N=value` from `$$`
    Setting { id: u16, value: String },
    /// `[MSG:...]`
    Message { text: String },
    /// `[GC:G0 G54 ...]` parser state
    ParserState { words: Vec<String> },
    /// `[PRB:x,y,z:1]`
    Probe { position: Vec<f64>, success: bool },
    /// `[G54:...]`, `[G28:...]`, `[G92:...]`, `[TLO:...]` from `$#`
    Offset { name: String, values: Vec<f64> },
    /// `[VER:...]`
    Version { text: String },
    /// `[OPT:...]`
    Options { text: String },
    /// `[echo:...]`
    Echo { text: String },
    /// `[HLP:...]`
    Help { text: String },
    /// Other bracketed feedback, e.g. `[Caution: Unlocked]` (0.9) or `[FIRMWARE:grblHAL]`
    Feedback { text: String },
    /// `>G54G20:ok` — startup block execution report
    StartupBlock { text: String },
    Other { text: String },
}

impl GrblLine {
    /// Short, stable discriminator used by the console filter in the UI.
    pub fn kind(&self) -> &'static str {
        match self {
            GrblLine::Ok => "ok",
            GrblLine::Error { .. } => "error",
            GrblLine::Alarm { .. } => "alarm",
            GrblLine::Status { .. } => "status",
            GrblLine::Welcome { .. } => "welcome",
            GrblLine::Setting { .. } => "setting",
            GrblLine::Message { .. } => "message",
            GrblLine::ParserState { .. } => "parserState",
            GrblLine::Probe { .. } => "probe",
            GrblLine::Offset { .. } => "offset",
            GrblLine::Version { .. } => "version",
            GrblLine::Options { .. } => "options",
            GrblLine::Echo { .. } => "echo",
            GrblLine::Help { .. } => "help",
            GrblLine::Feedback { .. } => "feedback",
            GrblLine::StartupBlock { .. } => "startup",
            GrblLine::Other { .. } => "other",
        }
    }

    /// Lines that acknowledge a queued command (consume one in-flight slot).
    pub fn is_ack(&self) -> bool {
        matches!(self, GrblLine::Ok | GrblLine::Error { .. })
    }
}

fn nums(s: &str) -> Vec<f64> {
    s.split(',').filter_map(|p| p.trim().parse().ok()).collect()
}

const OFFSET_NAMES: &[&str] = &["G54", "G55", "G56", "G57", "G58", "G59", "G28", "G30", "G92", "TLO"];

pub fn parse_line(raw: &str) -> GrblLine {
    let line = raw.trim();
    if line.eq_ignore_ascii_case("ok") {
        return GrblLine::Ok;
    }
    if let Some(rest) = strip_ci(line, "error:") {
        let rest = rest.trim();
        return GrblLine::Error { code: rest.parse().ok(), text: rest.to_string() };
    }
    if let Some(rest) = strip_ci(line, "alarm:") {
        let rest = rest.trim();
        return GrblLine::Alarm { code: rest.parse().ok(), text: rest.to_string() };
    }
    if line.starts_with('<') {
        if let Some(report) = parse_status(line) {
            return GrblLine::Status { report };
        }
    }
    if let Some(info) = parse_welcome(line) {
        return GrblLine::Welcome { info };
    }
    if let Some(rest) = line.strip_prefix('$') {
        if let Some((id, value)) = rest.split_once('=') {
            if let Ok(id) = id.parse::<u16>() {
                // 0.9 appends a comment: `$0=10 (step pulse, usec)`
                let value = value.split(" (").next().unwrap_or(value).trim().to_string();
                return GrblLine::Setting { id, value };
            }
        }
    }
    if let Some(rest) = line.strip_prefix('>') {
        return GrblLine::StartupBlock { text: rest.to_string() };
    }
    if let Some(inner) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        let (key, val) = inner.split_once(':').unwrap_or((inner, ""));
        return match key {
            "MSG" => GrblLine::Message { text: val.to_string() },
            "GC" => GrblLine::ParserState { words: val.split_whitespace().map(String::from).collect() },
            "PRB" => {
                let (pos, ok) = val.rsplit_once(':').unwrap_or((val, "0"));
                GrblLine::Probe { position: nums(pos), success: ok.trim() == "1" }
            }
            "VER" => GrblLine::Version { text: val.to_string() },
            "OPT" => GrblLine::Options { text: val.to_string() },
            "echo" => GrblLine::Echo { text: val.to_string() },
            "HLP" => GrblLine::Help { text: val.to_string() },
            k if OFFSET_NAMES.contains(&k) => GrblLine::Offset { name: k.to_string(), values: nums(val) },
            _ => GrblLine::Feedback { text: inner.to_string() },
        };
    }
    GrblLine::Other { text: line.to_string() }
}

fn strip_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_lines() {
        assert_eq!(parse_line("ok\r"), GrblLine::Ok);
        assert_eq!(parse_line("error:20"), GrblLine::Error { code: Some(20), text: "20".into() });
        assert_eq!(parse_line("ALARM:1"), GrblLine::Alarm { code: Some(1), text: "1".into() });
        assert!(matches!(parse_line("error: Bad number format"), GrblLine::Error { code: None, .. }));
        assert!(matches!(parse_line("ALARM: Hard/soft limit"), GrblLine::Alarm { code: None, .. }));
        assert_eq!(parse_line("$110=5000.000"), GrblLine::Setting { id: 110, value: "5000.000".into() });
        assert_eq!(parse_line("$0=10 (step pulse, usec)"), GrblLine::Setting { id: 0, value: "10".into() });
        assert_eq!(parse_line("[MSG:Pgm End]"), GrblLine::Message { text: "Pgm End".into() });
        assert_eq!(
            parse_line("[PRB:-10.000,-20.000,-30.500:1]"),
            GrblLine::Probe { position: vec![-10.0, -20.0, -30.5], success: true }
        );
        assert_eq!(
            parse_line("[G54:1.000,2.000,3.000]"),
            GrblLine::Offset { name: "G54".into(), values: vec![1.0, 2.0, 3.0] }
        );
        assert_eq!(parse_line("[TLO:0.000]"), GrblLine::Offset { name: "TLO".into(), values: vec![0.0] });
        match parse_line("[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]") {
            GrblLine::ParserState { words } => assert_eq!(words.len(), 11),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse_line("Grbl 1.1h ['$' for help]"), GrblLine::Welcome { .. }));
        assert!(matches!(parse_line("<Idle|MPos:0,0,0>"), GrblLine::Status { .. }));
        assert!(matches!(parse_line(">G54:ok"), GrblLine::StartupBlock { .. }));
        assert!(matches!(parse_line("[VER:1.1h.20190825:]"), GrblLine::Version { .. }));
        assert!(matches!(parse_line("[OPT:V,15,128]"), GrblLine::Options { .. }));
        assert!(matches!(parse_line("[Caution: Unlocked]"), GrblLine::Feedback { .. }));
        assert!(parse_line("ok").is_ack());
        assert!(!parse_line("ALARM:2").is_ack());
    }
}
