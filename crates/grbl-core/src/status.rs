//! Status report parsing (`<Idle|MPos:...|...>`) for GRBL 1.1 / grblHAL, with
//! a fallback for the comma-separated GRBL 0.9 format, plus a tracker that
//! caches `WCO`/`Ov`/`A` (which GRBL only sends every few reports) and derives
//! whichever of MPos/WPos the controller did not send.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "name", content = "sub", rename_all = "camelCase")]
pub enum MachineState {
    Idle,
    Run,
    /// 0 = hold complete, 1 = decelerating
    Hold(u8),
    Jog,
    Alarm,
    /// 0 = closed/ready, 1 = stopping, 2 = open, 3 = closing
    Door(u8),
    Check,
    Home,
    Sleep,
    /// grblHAL tool change state
    Tool,
    Unknown(String),
}

impl MachineState {
    pub fn parse(s: &str) -> Self {
        let (name, sub) = match s.split_once(':') {
            Some((n, v)) => (n, v.parse::<u8>().ok()),
            None => (s, None),
        };
        match name {
            "Idle" => Self::Idle,
            "Run" => Self::Run,
            "Hold" => Self::Hold(sub.unwrap_or(0)),
            "Jog" => Self::Jog,
            "Alarm" => Self::Alarm,
            "Door" => Self::Door(sub.unwrap_or(0)),
            "Check" => Self::Check,
            "Home" => Self::Home,
            "Sleep" => Self::Sleep,
            "Tool" => Self::Tool,
            other => Self::Unknown(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pins {
    pub x: bool,
    pub y: bool,
    pub z: bool,
    pub a: bool,
    pub probe: bool,
    pub door: bool,
    pub hold: bool,
    pub soft_reset: bool,
    pub cycle_start: bool,
    pub raw: String,
}

impl Pins {
    fn parse(s: &str) -> Self {
        let mut p = Pins { raw: s.to_string(), ..Default::default() };
        for c in s.chars() {
            match c {
                'X' => p.x = true,
                'Y' => p.y = true,
                'Z' => p.z = true,
                'A' => p.a = true,
                'P' => p.probe = true,
                'D' => p.door = true,
                'H' => p.hold = true,
                'R' => p.soft_reset = true,
                'S' => p.cycle_start = true,
                _ => {}
            }
        }
        p
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accessories {
    pub spindle_cw: bool,
    pub spindle_ccw: bool,
    pub flood: bool,
    pub mist: bool,
    pub raw: String,
}

impl Accessories {
    fn parse(s: &str) -> Self {
        Accessories {
            spindle_cw: s.contains('S'),
            spindle_ccw: s.contains('C'),
            flood: s.contains('F'),
            mist: s.contains('M'),
            raw: s.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    pub feed: u16,
    pub rapid: u16,
    pub spindle: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferState {
    /// Free planner blocks
    pub planner_free: u16,
    /// Free bytes in the serial RX buffer
    pub rx_free: u16,
}

/// One parsed status report, exactly as sent (no caching applied).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub state: Option<MachineState>,
    pub mpos: Option<Vec<f64>>,
    pub wpos: Option<Vec<f64>>,
    pub wco: Option<Vec<f64>>,
    pub feed: Option<f64>,
    pub spindle: Option<f64>,
    pub buffer: Option<BufferState>,
    pub line: Option<u32>,
    pub overrides: Option<Overrides>,
    pub pins: Option<Pins>,
    pub accessories: Option<Accessories>,
    /// Fields we did not recognise (grblHAL extensions etc.), kept verbatim.
    pub extra: Vec<String>,
}

fn parse_vec(s: &str) -> Option<Vec<f64>> {
    let v: Result<Vec<f64>, _> = s.split(',').map(|p| p.trim().parse::<f64>()).collect();
    v.ok().filter(|v| !v.is_empty())
}

/// Parse a status report line. Returns `None` if `line` is not one.
pub fn parse_status(line: &str) -> Option<StatusReport> {
    let t = line.trim();
    let inner = t.strip_prefix('<')?.strip_suffix('>')?;
    if inner.contains('|') || (!inner.contains(",MPos:") && !inner.contains(",WPos:")) {
        Some(parse_v11(inner))
    } else {
        Some(parse_v09(inner))
    }
}

fn parse_v11(inner: &str) -> StatusReport {
    let mut r = StatusReport::default();
    let mut fields = inner.split('|');
    if let Some(state) = fields.next() {
        r.state = Some(MachineState::parse(state));
    }
    for f in fields {
        let (key, val) = match f.split_once(':') {
            Some(kv) => kv,
            None => {
                r.extra.push(f.to_string());
                continue;
            }
        };
        match key {
            "MPos" => r.mpos = parse_vec(val),
            "WPos" => r.wpos = parse_vec(val),
            "WCO" => r.wco = parse_vec(val),
            "Bf" => {
                if let Some(v) = parse_vec(val) {
                    if v.len() >= 2 {
                        r.buffer = Some(BufferState { planner_free: v[0] as u16, rx_free: v[1] as u16 });
                    }
                }
            }
            "Ln" => r.line = val.trim().parse().ok(),
            "F" => r.feed = val.trim().parse().ok(),
            "FS" => {
                if let Some(v) = parse_vec(val) {
                    r.feed = v.first().copied();
                    r.spindle = v.get(1).copied();
                }
            }
            "Ov" => {
                if let Some(v) = parse_vec(val) {
                    if v.len() >= 3 {
                        r.overrides = Some(Overrides { feed: v[0] as u16, rapid: v[1] as u16, spindle: v[2] as u16 });
                    }
                }
            }
            "Pn" => r.pins = Some(Pins::parse(val)),
            "A" => r.accessories = Some(Accessories::parse(val)),
            _ => r.extra.push(f.to_string()),
        }
    }
    r
}

/// GRBL 0.9: `<Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000,Buf:0,RX:0>`
fn parse_v09(inner: &str) -> StatusReport {
    let mut r = StatusReport::default();
    let mut parts = inner.splitn(2, ',');
    r.state = parts.next().map(MachineState::parse);
    let rest = parts.next().unwrap_or("");
    // Split on the keys; values are comma separated numbers up to the next key.
    let mut current_key: Option<&str> = None;
    let mut current_vals: Vec<f64> = Vec::new();
    let flush = |key: Option<&str>, vals: &mut Vec<f64>, r: &mut StatusReport| {
        if let Some(k) = key {
            let v = std::mem::take(vals);
            match k {
                "MPos" => r.mpos = Some(v),
                "WPos" => r.wpos = Some(v),
                "Buf" => {
                    let planner_used = v.first().copied().unwrap_or(0.0);
                    let b = r.buffer.get_or_insert(BufferState { planner_free: 0, rx_free: 0 });
                    b.planner_free = (16.0 - planner_used).max(0.0) as u16;
                }
                "RX" => {
                    let rx_used = v.first().copied().unwrap_or(0.0);
                    let b = r.buffer.get_or_insert(BufferState { planner_free: 0, rx_free: 0 });
                    b.rx_free = (128.0 - rx_used).max(0.0) as u16;
                }
                "Ln" => r.line = v.first().map(|x| *x as u32),
                "F" => r.feed = v.first().copied(),
                _ => r.extra.push(k.to_string()),
            }
        }
    };
    for tok in rest.split(',') {
        if let Some((k, v)) = tok.split_once(':') {
            flush(current_key, &mut current_vals, &mut r);
            current_key = Some(k);
            if let Ok(n) = v.parse() {
                current_vals.push(n);
            }
        } else if let Ok(n) = tok.parse() {
            current_vals.push(n);
        }
    }
    flush(current_key, &mut current_vals, &mut r);
    r
}

/// Fully-resolved machine status, after applying cached fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineStatus {
    pub state: Option<MachineState>,
    pub mpos: Vec<f64>,
    pub wpos: Vec<f64>,
    pub wco: Vec<f64>,
    pub feed: f64,
    pub spindle: f64,
    pub buffer: Option<BufferState>,
    pub line: Option<u32>,
    pub overrides: Overrides,
    pub pins: Pins,
    pub accessories: Accessories,
}

impl Default for Overrides {
    fn default() -> Self {
        Overrides { feed: 100, rapid: 100, spindle: 100 }
    }
}

/// Keeps the last known WCO / overrides / accessories so every emitted
/// [`MachineStatus`] is complete.
#[derive(Debug, Default)]
pub struct StatusTracker {
    status: MachineStatus,
}

impl StatusTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> &MachineStatus {
        &self.status
    }

    /// Forget cached values (e.g. after a soft reset or reconnect).
    pub fn reset(&mut self) {
        self.status = MachineStatus::default();
    }

    pub fn apply(&mut self, r: &StatusReport) -> &MachineStatus {
        let s = &mut self.status;
        if let Some(st) = &r.state {
            s.state = Some(st.clone());
        }
        if let Some(w) = &r.wco {
            s.wco = w.clone();
        }
        let n = r.mpos.as_ref().or(r.wpos.as_ref()).map(|v| v.len()).unwrap_or(0);
        if s.wco.len() < n {
            s.wco.resize(n, 0.0);
        }
        match (&r.mpos, &r.wpos) {
            (Some(m), Some(w)) => {
                s.mpos = m.clone();
                s.wpos = w.clone();
            }
            (Some(m), None) => {
                s.mpos = m.clone();
                s.wpos = m.iter().zip(&s.wco).map(|(m, o)| m - o).collect();
            }
            (None, Some(w)) => {
                s.wpos = w.clone();
                s.mpos = w.iter().zip(&s.wco).map(|(w, o)| w + o).collect();
            }
            (None, None) => {}
        }
        if let Some(f) = r.feed {
            s.feed = f;
        }
        if let Some(sp) = r.spindle {
            s.spindle = sp;
        }
        if r.buffer.is_some() {
            s.buffer = r.buffer;
        }
        s.line = r.line;
        if let Some(o) = r.overrides {
            s.overrides = o;
            // GRBL only reports `A:` alongside `Ov:`; absence means "all off".
            s.accessories = r.accessories.clone().unwrap_or_default();
        } else if let Some(a) = &r.accessories {
            s.accessories = a.clone();
        }
        // `Pn:` is omitted when no pin is active.
        s.pins = r.pins.clone().unwrap_or_default();
        &self.status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_v11_report() {
        let r = parse_status("<Hold:1|MPos:-10.000,-5.500,-1.250|Bf:15,128|Ln:42|FS:1200,8000|WCO:-100.000,-50.000,-20.000|Ov:110,50,90|Pn:XPZ|A:SFM>").unwrap();
        assert_eq!(r.state, Some(MachineState::Hold(1)));
        assert_eq!(r.mpos, Some(vec![-10.0, -5.5, -1.25]));
        assert_eq!(r.buffer, Some(BufferState { planner_free: 15, rx_free: 128 }));
        assert_eq!(r.line, Some(42));
        assert_eq!(r.feed, Some(1200.0));
        assert_eq!(r.spindle, Some(8000.0));
        assert_eq!(r.overrides, Some(Overrides { feed: 110, rapid: 50, spindle: 90 }));
        let pins = r.pins.unwrap();
        assert!(pins.x && pins.probe && pins.z && !pins.y);
        let a = r.accessories.unwrap();
        assert!(a.spindle_cw && a.flood && a.mist && !a.spindle_ccw);
    }

    #[test]
    fn parses_all_states() {
        for (s, e) in [
            ("Idle", MachineState::Idle),
            ("Run", MachineState::Run),
            ("Hold:0", MachineState::Hold(0)),
            ("Jog", MachineState::Jog),
            ("Alarm", MachineState::Alarm),
            ("Door:2", MachineState::Door(2)),
            ("Check", MachineState::Check),
            ("Home", MachineState::Home),
            ("Sleep", MachineState::Sleep),
        ] {
            let r = parse_status(&format!("<{s}|MPos:0,0,0>")).unwrap();
            assert_eq!(r.state, Some(e));
        }
    }

    #[test]
    fn feed_only_and_wpos_variant() {
        let r = parse_status("<Idle|WPos:1.000,2.000,3.000,45.000|F:500>").unwrap();
        assert_eq!(r.wpos.unwrap().len(), 4);
        assert_eq!(r.feed, Some(500.0));
    }

    #[test]
    fn parses_v09_report() {
        let r = parse_status("<Idle,MPos:1.000,2.000,3.000,WPos:0.500,1.000,1.500,Buf:3,RX:20>").unwrap();
        assert_eq!(r.state, Some(MachineState::Idle));
        assert_eq!(r.mpos, Some(vec![1.0, 2.0, 3.0]));
        assert_eq!(r.wpos, Some(vec![0.5, 1.0, 1.5]));
        assert_eq!(r.buffer.unwrap().rx_free, 108);
    }

    #[test]
    fn tracker_caches_wco_and_derives_wpos() {
        let mut t = StatusTracker::new();
        t.apply(&parse_status("<Idle|MPos:-10,-10,-5|FS:0,0|WCO:-20,-20,-10>").unwrap());
        let s = t.apply(&parse_status("<Run|MPos:-15,-10,-5|FS:100,0>").unwrap()).clone();
        assert_eq!(s.wpos, vec![5.0, 10.0, 5.0]);
        assert_eq!(s.state, Some(MachineState::Run));
        // WPos-only reports derive MPos
        let s = t.apply(&parse_status("<Idle|WPos:0,0,0|FS:0,0>").unwrap()).clone();
        assert_eq!(s.mpos, vec![-20.0, -20.0, -10.0]);
    }

    #[test]
    fn non_status_lines_are_ignored() {
        assert!(parse_status("ok").is_none());
        assert!(parse_status("[MSG:Pgm End]").is_none());
    }
}
