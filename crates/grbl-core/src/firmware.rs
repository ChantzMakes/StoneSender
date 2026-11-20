//! Firmware identification from the welcome banner (and, later, `$I`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FirmwareKind {
    Grbl,
    Grblhal,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub kind: FirmwareKind,
    /// e.g. "1.1h", "0.9j", "1.1f"
    pub version: String,
    pub major: u32,
    pub minor: u32,
    /// True for GRBL < 1.1 (0.9 and older), which uses a different status
    /// format, text error messages and has no `$J=` jogging or overrides.
    pub legacy: bool,
    /// Human-readable warnings to show the user.
    pub warnings: Vec<String>,
    pub banner: String,
}

/// Parse a welcome banner like `Grbl 1.1h ['$' for help]` or
/// `GrblHAL 1.1f ['$' or '$HELP' for help]`. Returns `None` for other lines.
pub fn parse_welcome(line: &str) -> Option<FirmwareInfo> {
    let t = line.trim();
    let (kind, rest) = if let Some(r) = strip_prefix_ci(t, "grblhal ") {
        (FirmwareKind::Grblhal, r)
    } else {
        let r = strip_prefix_ci(t, "grbl ")?;
        (FirmwareKind::Grbl, r)
    };
    let version: String = rest.split_whitespace().next()?.to_string();
    let mut nums = version.split('.');
    let major: u32 = nums.next()?.parse().ok()?;
    let minor: u32 = nums
        .next()
        .map(|s| s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let legacy = kind == FirmwareKind::Grbl && (major, minor) < (1, 1);
    let mut warnings = Vec::new();
    if legacy {
        warnings.push(format!(
            "This controller runs GRBL {version}, which is older than 1.1. Jogging with $J=, \
             live feed/spindle overrides, laser mode ($32), most status fields and numeric \
             error codes are not available. Many cheap 3018 boards ship with 0.9 — flashing \
             GRBL 1.1 is strongly recommended."
        ));
    }
    Some(FirmwareInfo { kind, version, major, minor, legacy, warnings, banner: t.to_string() })
}

/// Build information from `$I`: `[VER:1.1h.20190830:]`, `[OPT:V,15,128]`,
/// grblHAL's `[FIRMWARE:grblHAL]`, or GRBL 0.9's bare `[0.9j.20160303:]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: Option<String>,
    pub build_date: Option<String>,
    pub options: Option<String>,
    /// Usable planner blocks reported by `[OPT:]`
    pub planner_blocks: Option<u16>,
    /// Serial RX buffer size reported by `[OPT:]`
    pub rx_buffer: Option<u16>,
    pub grblhal: bool,
}

impl BuildInfo {
    /// Feed one `$I` response line (inner text of the brackets, with key).
    /// Returns true if the line was build information.
    pub fn absorb(&mut self, key: &str, value: &str) -> bool {
        match key {
            "VER" => {
                let mut parts = value.split(['.', ':']);
                let (maj, min, date) = (parts.next(), parts.next(), parts.next());
                if let (Some(a), Some(b)) = (maj, min) {
                    self.version = Some(format!("{a}.{b}"));
                }
                self.build_date = date.filter(|d| !d.is_empty()).map(String::from);
                true
            }
            "OPT" => {
                let mut parts = value.split(',');
                self.options = parts.next().map(String::from);
                self.planner_blocks = parts.next().and_then(|v| v.trim().parse().ok());
                self.rx_buffer = parts.next().and_then(|v| v.trim().parse().ok());
                true
            }
            "FIRMWARE" => {
                self.grblhal = value.eq_ignore_ascii_case("grblhal");
                true
            }
            _ => false,
        }
    }

    /// A FirmwareInfo built from `$I` when no welcome banner was seen (boards
    /// that don't reset when the port opens).
    pub fn to_firmware(&self) -> Option<FirmwareInfo> {
        let v = self.version.as_ref()?;
        let kind = if self.grblhal { "GrblHAL" } else { "Grbl" };
        parse_welcome(&format!("{kind} {v}"))
    }
}

/// GRBL 0.9's `$I` prints `[0.9j.20160303:]` (no `VER:` key).
pub fn parse_legacy_build(text: &str) -> Option<String> {
    let mut parts = text.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let date = parts.next()?;
    if major.chars().all(|c| c.is_ascii_digit()) && minor.chars().next()?.is_ascii_digit() && date.trim_end_matches(':').len() == 8 {
        Some(format!("{major}.{minor}"))
    } else {
        None
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_versions() {
        let g = parse_welcome("Grbl 1.1h ['$' for help]").unwrap();
        assert_eq!((g.kind, g.major, g.minor, g.legacy), (FirmwareKind::Grbl, 1, 1, false));
        let old = parse_welcome("Grbl 0.9j ['$' for help]").unwrap();
        assert!(old.legacy);
        assert_eq!(old.warnings.len(), 1);
        let hal = parse_welcome("GrblHAL 1.1f ['$' or '$HELP' for help]").unwrap();
        assert_eq!(hal.kind, FirmwareKind::Grblhal);
        assert!(!hal.legacy);
        assert!(parse_welcome("ok").is_none());
        assert!(parse_welcome("[MSG:Grbl 1.1]").is_none());
    }

    #[test]
    fn build_info_from_dollar_i() {
        let mut b = BuildInfo::default();
        assert!(b.absorb("VER", "1.1h.20190830:"));
        assert!(b.absorb("OPT", "V,15,128"));
        assert_eq!(b.version.as_deref(), Some("1.1h"));
        assert_eq!((b.planner_blocks, b.rx_buffer), (Some(15), Some(128)));
        assert_eq!(b.to_firmware().unwrap().kind, FirmwareKind::Grbl);
        let mut h = BuildInfo::default();
        h.absorb("VER", "1.1f.20240101:");
        h.absorb("OPT", "VNMSL,35,1024,3,0");
        h.absorb("FIRMWARE", "grblHAL");
        assert_eq!(h.rx_buffer, Some(1024));
        assert_eq!(h.to_firmware().unwrap().kind, FirmwareKind::Grblhal);
        assert_eq!(parse_legacy_build("0.9j.20160303:").as_deref(), Some("0.9j"));
        assert!(parse_legacy_build("Caution: Unlocked").is_none());
    }
}
