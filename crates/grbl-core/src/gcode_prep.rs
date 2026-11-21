//! Job preparation: strip comments/whitespace so lines use as little of
//! GRBL's RX buffer as possible, and scan for anything the controller will
//! reject (or that the user should know about) *before* a job starts.
//!
//! This is not the full interpreter (Phase 3); it only understands words.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// 1-based source line
    pub line: u32,
    pub severity: Severity,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLine {
    /// 1-based line number in the original file
    pub source_line: u32,
    /// Text to send. M6 is removed (tool changes are handled by the app), so
    /// a line that held only `M6` is empty.
    pub text: String,
    /// Set when the source line contained M6
    pub tool_change: Option<ToolChange>,
}

/// Borrowed view of one prepared line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineRef<'a> {
    pub source_line: u32,
    pub text: &'a str,
    pub tool_change: Option<&'a ToolChange>,
}

impl LineRef<'_> {
    pub fn to_owned_line(&self) -> PreparedLine {
        PreparedLine { source_line: self.source_line, text: self.text.to_string(), tool_change: self.tool_change.cloned() }
    }
}

/// Compact storage for millions of prepared lines (Phase 8 performance pass):
/// one text buffer + end offsets instead of a heap string per line
/// (5M lines: ~370 MB as `Vec<PreparedLine>`, ~150 MB here).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PreparedLines {
    text: String,
    /// End offset in `text` of each line
    ends: Vec<u32>,
    source: Vec<u32>,
    /// (line index, tool change), sorted by index
    tool_changes: Vec<(u32, ToolChange)>,
}

impl PreparedLines {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.ends.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }
    pub fn push(&mut self, source_line: u32, text: &str, tool_change: Option<ToolChange>) {
        self.text.push_str(text);
        assert!(self.text.len() <= u32::MAX as usize, "job text larger than 4 GB");
        if let Some(tc) = tool_change {
            self.tool_changes.push((self.ends.len() as u32, tc));
        }
        self.ends.push(self.text.len() as u32);
        self.source.push(source_line);
    }
    pub fn text(&self, i: usize) -> &str {
        let start = if i == 0 { 0 } else { self.ends[i - 1] as usize };
        &self.text[start..self.ends[i] as usize]
    }
    pub fn source_line(&self, i: usize) -> u32 {
        self.source[i]
    }
    pub fn tool_change(&self, i: usize) -> Option<&ToolChange> {
        self.tool_changes.binary_search_by_key(&(i as u32), |(k, _)| *k).ok().map(|k| &self.tool_changes[k].1)
    }
    pub fn get(&self, i: usize) -> Option<LineRef<'_>> {
        (i < self.len()).then(|| LineRef { source_line: self.source[i], text: self.text(i), tool_change: self.tool_change(i) })
    }
    pub fn iter(&self) -> impl Iterator<Item = LineRef<'_>> + '_ {
        (0..self.len()).map(|i| self.get(i).expect("index in range"))
    }
    /// The lines from source line `from` on (start from line).
    pub fn from_source_line(&self, from: u32) -> PreparedLines {
        let mut out = PreparedLines::new();
        for l in self.iter().filter(|l| l.source_line >= from) {
            out.push(l.source_line, l.text, l.tool_change.cloned());
        }
        out
    }
}

impl From<Vec<PreparedLine>> for PreparedLines {
    fn from(v: Vec<PreparedLine>) -> Self {
        let mut out = PreparedLines::new();
        for l in v {
            out.push(l.source_line, &l.text, l.tool_change);
        }
        out
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChange {
    pub line: u32,
    pub tool: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFeatures {
    pub units_mm: bool,
    pub units_inch: bool,
    pub spindle_cw: bool,
    pub spindle_ccw: bool,
    pub max_s: f64,
    /// Lines that change S on a G1/G2/G3 move (typical of laser jobs)
    pub s_changes_on_moves: u32,
    pub tool_changes: Vec<ToolChange>,
    pub tools: Vec<u32>,
    pub arcs: bool,
    pub probe: bool,
    pub coolant_mist: bool,
    pub coolant_flood: bool,
    pub z_words: u32,
    pub a_words: u32,
    pub wcs_used: Vec<String>,
    pub program_end: bool,
    pub system_commands: u32,
    pub dwell_after_spindle: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobScan {
    pub source_lines: u32,
    /// Lines that will actually be sent
    pub lines: u32,
    pub bytes: u64,
    pub issues: Vec<Issue>,
    /// Issues beyond this cap are counted but not listed
    pub issues_truncated: u32,
    pub features: JobFeatures,
}

impl JobScan {
    pub fn has_errors(&self) -> bool {
        self.issues.iter().any(|i| i.severity == Severity::Error)
    }
}

/// What the connected controller accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirmwareCaps {
    pub max_line_len: usize,
    pub supports_m6: bool,
    pub supports_m7: bool,
    pub supports_a_axis: bool,
}

impl FirmwareCaps {
    pub const GRBL11: FirmwareCaps = FirmwareCaps { max_line_len: 79, supports_m6: false, supports_m7: false, supports_a_axis: false };
    pub const GRBLHAL: FirmwareCaps = FirmwareCaps { max_line_len: 255, supports_m6: true, supports_m7: true, supports_a_axis: true };
}

const MAX_LISTED_ISSUES: usize = 200;

/// Remove comments and whitespace, upper-case. Returns an empty string for
/// lines that contain nothing to send.
pub fn clean_line(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_paren = false;
    for c in raw.chars() {
        if in_paren {
            if c == ')' {
                in_paren = false;
            }
            continue;
        }
        match c {
            '(' => in_paren = true,
            ';' => break,
            '%' => {}
            c if c.is_whitespace() => {}
            c => out.push(c.to_ascii_uppercase()),
        }
    }
    out
}

fn g_name(v: f64) -> String {
    if (v - v.round()).abs() < 1e-6 {
        format!("G{}", v.round() as i64)
    } else {
        format!("G{v}")
    }
}

/// Prepare and scan a whole job.
pub fn prepare(source: &str, caps: &FirmwareCaps) -> (PreparedLines, JobScan) {
    let mut lines = PreparedLines::new();
    let mut scan = JobScan::default();
    let issue = |scan: &mut JobScan, line: u32, severity: Severity, code: &str, message: String| {
        if scan.issues.len() < MAX_LISTED_ISSUES {
            scan.issues.push(Issue { line, severity, code: code.into(), message });
        } else {
            scan.issues_truncated += 1;
        }
    };
    let mut spindle_started_line: Option<u32> = None;
    for (idx, raw) in source.lines().enumerate() {
        let n = idx as u32 + 1;
        scan.source_lines = n;
        if !raw.is_ascii() {
            issue(&mut scan, n, Severity::Error, "non-ascii", "contains non-ASCII characters GRBL cannot read".into());
            continue;
        }
        let text = clean_line(raw);
        if text.is_empty() {
            continue;
        }
        if text.contains(['?', '!', '~']) {
            issue(&mut scan, n, Severity::Error, "realtime-char", "contains ?, ! or ~ outside a comment — GRBL would treat it as a real-time command".into());
            continue;
        }
        if text.len() > caps.max_line_len {
            issue(&mut scan, n, Severity::Error, "too-long", format!("{} characters after removing comments; the controller accepts {}", text.len(), caps.max_line_len));
        }
        if let Some(rest) = text.strip_prefix('$') {
            scan.features.system_commands += 1;
            if rest.contains('=') && !rest.starts_with("J=") {
                issue(&mut scan, n, Severity::Error, "settings-write", "changes a controller setting — jobs may not do that; use the settings editor".into());
            } else if rest == "H" {
                issue(&mut scan, n, Severity::Warning, "system-command", "runs a homing cycle in the middle of the job".into());
            } else {
                issue(&mut scan, n, Severity::Warning, "system-command", format!("contains the system command {text}"));
            }
            scan.lines += 1;
            scan.bytes += text.len() as u64 + 1;
            lines.push(n, &text, None);
            continue;
        }
        let mut is_motion = false;
        let mut m6_words: Vec<(usize, usize)> = Vec::new();
        let mut has_s = false;
        let mut has_m6 = false;
        let mut t_word = None;
        let mut bad = false;
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let letter = bytes[i] as char;
            let word_start = i;
            if !letter.is_ascii_alphabetic() {
                issue(&mut scan, n, Severity::Error, "syntax", format!("unexpected character '{letter}' (variables and expressions are not supported by GRBL)"));
                bad = true;
                break;
            }
            i += 1;
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || matches!(bytes[i], b'.' | b'-' | b'+')) {
                i += 1;
            }
            let Ok(v) = text[start..i].parse::<f64>() else {
                issue(&mut scan, n, Severity::Error, "syntax", format!("'{letter}' needs a number"));
                bad = true;
                break;
            };
            match letter {
                'G' => {
                    let code = (v * 10.0).round() as i32;
                    match code {
                        0 | 10 => is_motion |= code == 10,
                        20 | 30 => {
                            is_motion = true;
                            scan.features.arcs = true;
                        }
                        200 => scan.features.units_inch = true,
                        210 => scan.features.units_mm = true,
                        382..=385 => scan.features.probe = true,
                        540 | 550 | 560 | 570 | 580 | 590 => {
                            let name = g_name(v);
                            if !scan.features.wcs_used.contains(&name) {
                                scan.features.wcs_used.push(name);
                            }
                        }
                        40 | 100 | 170 | 180 | 190 | 280 | 281 | 300 | 301 | 400 | 431 | 490 | 530 | 610 | 800 | 900 | 910 | 911 | 920 | 921 | 930 | 940 => {}
                        410 | 420 => issue(&mut scan, n, Severity::Error, "unsupported", format!("{} (cutter compensation) is not supported by GRBL — regenerate the toolpath with compensation done by your CAM", g_name(v))),
                        810..=890 => issue(&mut scan, n, Severity::Error, "unsupported", format!("{} (canned drilling cycle) is not supported by GRBL — post-process with a GRBL post processor", g_name(v))),
                        _ => issue(&mut scan, n, Severity::Error, "unsupported", format!("{} is not supported by GRBL", g_name(v))),
                    }
                }
                'M' => match v.round() as i32 {
                    0 | 1 | 2 | 30 => scan.features.program_end |= matches!(v.round() as i32, 2 | 30),
                    3 => {
                        scan.features.spindle_cw = true;
                        spindle_started_line = Some(n);
                    }
                    4 => {
                        scan.features.spindle_ccw = true;
                        spindle_started_line = Some(n);
                    }
                    5 | 9 => {}
                    6 => {
                        has_m6 = true;
                        m6_words.push((word_start, i));
                    }
                    7 => {
                        scan.features.coolant_mist = true;
                        if !caps.supports_m7 {
                            issue(&mut scan, n, Severity::Error, "unsupported", "M7 (mist coolant) is rejected by stock GRBL 1.1 (error:20). Use M8, or grblHAL".into());
                        }
                    }
                    8 => scan.features.coolant_flood = true,
                    other => issue(&mut scan, n, Severity::Error, "unsupported", format!("M{other} is not supported by GRBL")),
                },
                'S' => {
                    has_s = true;
                    scan.features.max_s = scan.features.max_s.max(v);
                }
                'T' => t_word = Some(v.max(0.0) as u32),
                'Z' => scan.features.z_words += 1,
                'A' => {
                    scan.features.a_words += 1;
                    if !caps.supports_a_axis {
                        issue(&mut scan, n, Severity::Warning, "a-axis", "uses an A axis; make sure your controller has one".into());
                    }
                }
                'N' | 'F' | 'P' | 'R' | 'L' | 'X' | 'Y' | 'I' | 'J' | 'K' => {}
                other => issue(&mut scan, n, Severity::Error, "unsupported", format!("the '{other}' word is not supported by GRBL")),
            }
        }
        if bad {
            continue;
        }
        if let Some(t) = t_word {
            if !scan.features.tools.contains(&t) {
                scan.features.tools.push(t);
            }
        }
        let mut tool_change = None;
        let mut text = text;
        if has_m6 {
            let tc = ToolChange { line: n, tool: t_word };
            tool_change = Some(tc.clone());
            for &(a, b) in m6_words.iter().rev() {
                text.replace_range(a..b, "");
            }
            scan.features.tool_changes.push(tc);
            if !caps.supports_m6 {
                issue(&mut scan, n, Severity::Info, "tool-change", "M6 tool change: GRBL 1.1 rejects M6; the app handles it according to your profile's tool change setting".into());
            }
        }
        if text.contains("G4") && spindle_started_line.is_some_and(|l| n <= l + 2) {
            scan.features.dwell_after_spindle = true;
        }
        if has_s && is_motion {
            scan.features.s_changes_on_moves += 1;
        }
        scan.lines += 1;
        scan.bytes += text.len() as u64 + 1;
        lines.push(n, &text, tool_change);
    }
    (lines, scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_whitespace() {
        assert_eq!(clean_line("g1 x10 ( comment ) y20 ; tail"), "G1X10Y20");
        assert_eq!(clean_line("(only comment)"), "");
        assert_eq!(clean_line("%"), "");
    }

    #[test]
    fn prepares_and_maps_source_lines() {
        let src = "(header)\nG21 G90\n\nG0 X1 Y2\nM3 S1000\nG4 P2\nG1 X5 F100\nM30\n";
        let (lines, scan) = prepare(src, &FirmwareCaps::GRBL11);
        assert_eq!(lines.len(), 6);
        assert_eq!(lines.get(0).unwrap().to_owned_line(), PreparedLine { source_line: 2, text: "G21G90".into(), tool_change: None });
        assert_eq!(scan.lines, 6);
        assert!(scan.features.units_mm && scan.features.spindle_cw && scan.features.program_end);
        assert!(scan.features.dwell_after_spindle);
        assert_eq!(scan.features.max_s, 1000.0);
        assert!(!scan.has_errors());
    }

    #[test]
    fn removes_m6_and_marks_tool_changes() {
        let (lines, scan) = prepare("T2 M6
M06
G0 Z5 M6 T3
", &FirmwareCaps::GRBL11);
        assert_eq!(lines.iter().map(|l| l.text).collect::<Vec<_>>(), vec!["T2", "", "G0Z5T3"]);
        assert_eq!(lines.tool_change(0), Some(&ToolChange { line: 1, tool: Some(2) }));
        assert_eq!(lines.tool_change(1), Some(&ToolChange { line: 2, tool: None }));
        assert_eq!(lines.tool_change(2), Some(&ToolChange { line: 3, tool: Some(3) }));
        assert_eq!(lines.tool_change(3), None);
        assert_eq!(lines.from_source_line(2).iter().map(|l| l.text).collect::<Vec<_>>(), vec!["", "G0Z5T3"]);
        assert_eq!(lines.from_source_line(2).tool_change(0), Some(&ToolChange { line: 2, tool: None }));
        assert_eq!(scan.features.tool_changes.len(), 3);
        assert!(!scan.has_errors());
    }

    #[test]
    fn flags_unsupported_and_dangerous_lines() {
        let src = "G41 D1\nG81 Z-1 R1\nM7\nG0 X1 (why?) Y2\nG0 X1 ? \n$110=100\nO100\n#1=5\n$H\nT2 M6\n";
        let (_, scan) = prepare(src, &FirmwareCaps::GRBL11);
        let codes: Vec<(u32, &str)> = scan.issues.iter().map(|i| (i.line, i.code.as_str())).collect();
        assert!(codes.contains(&(1, "unsupported")));
        assert!(codes.contains(&(2, "unsupported")));
        assert!(codes.contains(&(3, "unsupported")));
        assert!(!codes.iter().any(|(l, _)| *l == 4), "a ? inside a comment is fine");
        assert!(codes.contains(&(5, "realtime-char")));
        assert!(codes.contains(&(6, "settings-write")));
        assert!(codes.contains(&(7, "unsupported")));
        assert!(codes.contains(&(8, "syntax")));
        assert!(codes.contains(&(9, "system-command")));
        assert_eq!(scan.features.tool_changes, vec![ToolChange { line: 10, tool: Some(2) }]);
        assert!(scan.has_errors());
        // grblHAL accepts M7
        let (_, hal) = prepare("M7\n", &FirmwareCaps::GRBLHAL);
        assert!(!hal.has_errors());
    }

    #[test]
    fn detects_laser_style_power_changes_and_long_lines() {
        let src = "M4 S0\nG1 X1 S100 F1000\nG1 X2 S200\nG1 X3 S300\n";
        let (_, scan) = prepare(src, &FirmwareCaps::GRBL11);
        assert_eq!(scan.features.s_changes_on_moves, 3);
        assert!(scan.features.spindle_ccw);
        let long = format!("G1 X{}", "1".repeat(100));
        let (_, scan) = prepare(&long, &FirmwareCaps::GRBL11);
        assert_eq!(scan.issues[0].code, "too-long");
    }
}
