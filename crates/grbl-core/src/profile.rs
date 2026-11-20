//! Machine Profile — the Rust mirror of `src/lib/profile/schema.ts`.
//!
//! The TypeScript Zod schema is the *source of truth* for defaults and
//! migration (profiles are migrated in the frontend before they are saved).
//! This mirror exists so the backend can (a) refuse to persist malformed data,
//! and (b) configure the virtual GRBL device from a profile.
//!
//! All lengths are millimetres, feeds mm/min, accelerations mm/s². The A axis
//! uses degrees (deg/min, deg/s², steps/deg). `units` only affects display.
//!
//! Parity with the TS schema is enforced by tests that parse every preset in
//! `presets/*.json` with both implementations.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Axis3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Axis4 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub a: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Units {
    Mm,
    Inch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MachineType {
    Router,
    Laser,
    RouterLaser,
    Rotary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FirmwarePreference {
    Auto,
    Grbl,
    Grblhal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamingMode {
    CharacterCounting,
    SendResponse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    pub notes: String,
    pub icon: Option<String>,
    pub preset_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    pub firmware: FirmwarePreference,
    pub baud_rate: u32,
    pub status_poll_hz: f64,
    pub streaming_mode: StreamingMode,
    pub rx_buffer_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GantryStyle {
    MovingGantry,
    MovingTable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HomeCorner {
    FrontLeft,
    FrontRight,
    BackLeft,
    BackRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ZHomeDirection {
    Up,
    Down,
}

/// How GRBL numbers machine coordinates after homing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoordinateMode {
    /// Stock GRBL 1.1: the work area spans `[-travel, 0]` on every axis.
    NegativeSpace,
    /// `HOMING_FORCE_SET_ORIGIN` builds: home is 0, axes homing toward their
    /// minimum count up to `+travel`.
    PositiveSpace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub auto: bool,
    pub size: Axis3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub envelope: Axis3,
    pub gantry_style: GantryStyle,
    pub dual_motor_y: bool,
    pub frame: Frame,
    pub home_corner: HomeCorner,
    pub z_home_direction: ZHomeDirection,
    pub coordinate_mode: CoordinateMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub max_rate: Axis4,
    pub acceleration: Axis4,
    pub junction_deviation: f64,
    pub arc_tolerance: f64,
    pub steps_per_unit: Axis4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HomingSequence {
    ZThenXy,
    ZThenXThenY,
    AllTogether,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Homing {
    pub enabled: bool,
    pub soft_limits: bool,
    pub hard_limits: bool,
    pub pull_off: f64,
    pub seek_rate: f64,
    pub feed_rate: f64,
    pub sequence: HomingSequence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpindleType {
    Router,
    Pwm,
    Vfd,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spindle {
    #[serde(rename = "type")]
    pub kind: SpindleType,
    pub min_rpm: f64,
    pub max_rpm: f64,
    pub spin_up_delay_sec: f64,
    pub supports_m4: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AirAssist {
    None,
    #[serde(rename = "M7")]
    M7,
    #[serde(rename = "M8")]
    M8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Laser {
    pub max_power: f64,
    pub laser_mode: bool,
    pub default_m4_dynamic: bool,
    pub focus_height: f64,
    pub framing_feed: f64,
    pub framing_power_percent: f64,
    pub air_assist: AirAssist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RotaryMode {
    AAxis,
    YSubstitution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiameterHandling {
    Fixed,
    AskPerJob,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rotary {
    pub mode: RotaryMode,
    pub axis_parallel_to: String,
    pub default_stock_diameter: f64,
    pub diameter_handling: DiameterHandling,
    pub y_mm_per_revolution: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlateType {
    None,
    Z,
    Xyz,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSetter {
    pub enabled: bool,
    pub position: Axis3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub plate_type: PlateType,
    pub plate_thickness: f64,
    pub xy_offset: XY,
    pub fast_feed: f64,
    pub slow_feed: f64,
    pub retract: f64,
    pub max_travel: f64,
    pub tool_setter: ToolSetter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolChangeStrategy {
    Ignore,
    Pause,
    PauseReprobe,
    ToolSetter,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChange {
    pub strategy: ToolChangeStrategy,
    pub position: Axis3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Safety {
    pub safe_z_machine: f64,
    pub clearance_z: f64,
    pub park_position: Axis3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JogDefaults {
    pub steps_mm: Vec<f64>,
    pub default_step_mm: f64,
    #[serde(rename = "feedXY")]
    pub feed_xy: f64,
    pub feed_z: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDefaults {
    pub size: Axis3,
    pub material: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    pub jog: JogDefaults,
    pub stock: StockDefaults,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineProfile {
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub identity: Identity,
    pub units: Units,
    pub machine_type: MachineType,
    pub controller: Controller,
    pub geometry: Geometry,
    pub motion: Motion,
    pub homing: Homing,
    pub spindle: Spindle,
    pub laser: Laser,
    pub rotary: Rotary,
    pub probe: Probe,
    pub tool_change: ToolChange,
    pub safety: Safety,
    pub defaults: Defaults,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProfileError {
    #[error("profile JSON is invalid: {0}")]
    Parse(String),
    #[error("unsupported schema version {found} (this build understands {expected})")]
    Version { found: u32, expected: u32 },
    #[error("invalid value for {field}: {reason}")]
    Invalid { field: String, reason: String },
}

fn check(cond: bool, field: &str, reason: &str) -> Result<(), ProfileError> {
    if cond {
        Ok(())
    } else {
        Err(ProfileError::Invalid { field: field.into(), reason: reason.into() })
    }
}

fn positive(v: f64, field: &str) -> Result<(), ProfileError> {
    check(v.is_finite() && v > 0.0, field, "must be a positive number")
}

impl MachineProfile {
    /// Parse and validate. The frontend migrates older versions before saving,
    /// so the backend only accepts the current schema version.
    pub fn from_json(json: &str) -> Result<Self, ProfileError> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| ProfileError::Parse(e.to_string()))?;
        Self::from_value(value)
    }

    pub fn from_value(value: serde_json::Value) -> Result<Self, ProfileError> {
        let found = value.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if found != SCHEMA_VERSION {
            return Err(ProfileError::Version { found, expected: SCHEMA_VERSION });
        }
        let p: MachineProfile =
            serde_json::from_value(value).map_err(|e| ProfileError::Parse(e.to_string()))?;
        p.validate()?;
        Ok(p)
    }

    /// Range checks that mirror the Zod refinements. Kept deliberately to the
    /// checks that matter for safety and for the emulator; the UI shows the
    /// richer Zod messages.
    pub fn validate(&self) -> Result<(), ProfileError> {
        check(!self.id.trim().is_empty(), "id", "must not be empty")?;
        let name = self.identity.name.trim();
        check(!name.is_empty() && name.chars().count() <= 60, "identity.name", "1–60 characters")?;
        check(
            (1200..=2_000_000).contains(&self.controller.baud_rate),
            "controller.baudRate",
            "must be between 1200 and 2000000",
        )?;
        check(
            (1.0..=20.0).contains(&self.controller.status_poll_hz),
            "controller.statusPollHz",
            "must be between 1 and 20 Hz",
        )?;
        check(
            (64..=16384).contains(&self.controller.rx_buffer_size),
            "controller.rxBufferSize",
            "must be between 64 and 16384 bytes",
        )?;
        let e = &self.geometry.envelope;
        positive(e.x, "geometry.envelope.x")?;
        positive(e.y, "geometry.envelope.y")?;
        positive(e.z, "geometry.envelope.z")?;
        for (n, a) in [("maxRate", &self.motion.max_rate), ("acceleration", &self.motion.acceleration), ("stepsPerUnit", &self.motion.steps_per_unit)] {
            positive(a.x, &format!("motion.{n}.x"))?;
            positive(a.y, &format!("motion.{n}.y"))?;
            positive(a.z, &format!("motion.{n}.z"))?;
            positive(a.a, &format!("motion.{n}.a"))?;
        }
        positive(self.motion.junction_deviation, "motion.junctionDeviation")?;
        positive(self.motion.arc_tolerance, "motion.arcTolerance")?;
        check(self.homing.pull_off >= 0.0, "homing.pullOff", "must be ≥ 0")?;
        check(
            self.spindle.max_rpm > 0.0 && self.spindle.min_rpm >= 0.0 && self.spindle.min_rpm < self.spindle.max_rpm,
            "spindle",
            "min RPM must be ≥ 0 and below max RPM",
        )?;
        positive(self.laser.max_power, "laser.maxPower")?;
        check(
            (0.0..=100.0).contains(&self.laser.framing_power_percent),
            "laser.framingPowerPercent",
            "0–100 %",
        )?;
        positive(self.probe.slow_feed, "probe.slowFeed")?;
        positive(self.probe.fast_feed, "probe.fastFeed")?;
        check(self.probe.plate_thickness >= 0.0, "probe.plateThickness", "must be ≥ 0")?;
        check(!self.defaults.jog.steps_mm.is_empty(), "defaults.jog.stepsMm", "need at least one step")?;
        Ok(())
    }

    pub fn has_rotary(&self) -> bool {
        self.machine_type == MachineType::Rotary && self.rotary.mode == RotaryMode::AAxis
    }

    /// Axis homes toward its minimum (negative) end?  `[x, y, z]`
    pub fn homes_negative(&self) -> [bool; 3] {
        let (x_neg, y_neg) = match self.geometry.home_corner {
            HomeCorner::FrontLeft => (true, true),
            HomeCorner::FrontRight => (false, true),
            HomeCorner::BackLeft => (true, false),
            HomeCorner::BackRight => (false, false),
        };
        [x_neg, y_neg, self.geometry.z_home_direction == ZHomeDirection::Down]
    }

    /// Machine-coordinate bounds `(min, max)` of the work envelope, following
    /// GRBL 1.1's homing conventions (see `limits.c::limits_go_home`).
    pub fn machine_bounds(&self) -> ([f64; 3], [f64; 3]) {
        let travel = [self.geometry.envelope.x, self.geometry.envelope.y, self.geometry.envelope.z];
        let neg = self.homes_negative();
        let mut min = [0.0; 3];
        let mut max = [0.0; 3];
        for i in 0..3 {
            match self.geometry.coordinate_mode {
                CoordinateMode::NegativeSpace => {
                    min[i] = -travel[i];
                    max[i] = 0.0;
                }
                CoordinateMode::PositiveSpace => {
                    if neg[i] {
                        min[i] = 0.0;
                        max[i] = travel[i];
                    } else {
                        min[i] = -travel[i];
                        max[i] = 0.0;
                    }
                }
            }
        }
        (min, max)
    }

    /// The `$$` values this profile expects the controller to have. Used to
    /// configure the virtual device and (Phase 2) to diff against a real one.
    pub fn to_grbl_settings(&self) -> BTreeMap<u16, f64> {
        let m = &self.motion;
        let h = &self.homing;
        let neg = self.homes_negative();
        let mut dir_mask = 0u8;
        for (i, n) in neg.iter().enumerate() {
            if *n {
                dir_mask |= 1 << i;
            }
        }
        let b = |v: bool| if v { 1.0 } else { 0.0 };
        let laser_like = matches!(self.machine_type, MachineType::Laser);
        let mut s = BTreeMap::new();
        s.insert(0, 10.0);
        s.insert(1, 25.0);
        s.insert(2, 0.0);
        s.insert(3, 0.0);
        s.insert(4, 0.0);
        s.insert(5, 0.0);
        s.insert(6, 0.0);
        s.insert(10, 1.0);
        s.insert(11, m.junction_deviation);
        s.insert(12, m.arc_tolerance);
        s.insert(13, if self.units == Units::Inch { 1.0 } else { 0.0 });
        s.insert(20, b(h.soft_limits));
        s.insert(21, b(h.hard_limits));
        s.insert(22, b(h.enabled));
        s.insert(23, dir_mask as f64);
        s.insert(24, h.feed_rate);
        s.insert(25, h.seek_rate);
        s.insert(26, 250.0);
        s.insert(27, h.pull_off);
        s.insert(30, if laser_like { self.laser.max_power } else { self.spindle.max_rpm });
        s.insert(31, if laser_like { 0.0 } else { self.spindle.min_rpm });
        s.insert(32, b(laser_like || (self.machine_type == MachineType::RouterLaser && self.laser.laser_mode)));
        s.insert(100, m.steps_per_unit.x);
        s.insert(101, m.steps_per_unit.y);
        s.insert(102, m.steps_per_unit.z);
        s.insert(110, m.max_rate.x);
        s.insert(111, m.max_rate.y);
        s.insert(112, m.max_rate.z);
        s.insert(120, m.acceleration.x);
        s.insert(121, m.acceleration.y);
        s.insert(122, m.acceleration.z);
        s.insert(130, self.geometry.envelope.x);
        s.insert(131, self.geometry.envelope.y);
        s.insert(132, self.geometry.envelope.z);
        if self.has_rotary() {
            s.insert(103, m.steps_per_unit.a);
            s.insert(113, m.max_rate.a);
            s.insert(123, m.acceleration.a);
            s.insert(133, 0.0);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(name: &str) -> String {
        let path = format!("{}/../../presets/{name}.json", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    const PRESETS: &[&str] = &[
        "generic-router",
        "generic-laser",
        "desktop-3018",
        "shapeoko",
        "x-carve",
        "longmill",
        "onefinity",
        "generic-rotary",
    ];

    #[test]
    fn every_preset_parses_and_validates() {
        for p in PRESETS {
            let profile = MachineProfile::from_json(&preset(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
            assert_eq!(profile.schema_version, SCHEMA_VERSION);
        }
    }

    #[test]
    fn rejects_unknown_fields_and_versions() {
        let mut v: serde_json::Value = serde_json::from_str(&preset("generic-router")).unwrap();
        v["schemaVersion"] = 99.into();
        assert!(matches!(MachineProfile::from_value(v.clone()), Err(ProfileError::Version { found: 99, .. })));
        v["schemaVersion"] = 1.into();
        v["surprise"] = true.into();
        assert!(matches!(MachineProfile::from_value(v), Err(ProfileError::Parse(_))));
    }

    #[test]
    fn rejects_bad_ranges() {
        let mut v: serde_json::Value = serde_json::from_str(&preset("generic-router")).unwrap();
        v["geometry"]["envelope"]["x"] = (-5.0).into();
        let err = MachineProfile::from_value(v).unwrap_err();
        assert!(matches!(err, ProfileError::Invalid { ref field, .. } if field == "geometry.envelope.x"));
    }

    #[test]
    fn homing_mask_and_bounds() {
        let mut p = MachineProfile::from_json(&preset("generic-router")).unwrap();
        p.geometry.home_corner = HomeCorner::FrontLeft;
        p.geometry.z_home_direction = ZHomeDirection::Up;
        assert_eq!(p.to_grbl_settings()[&23], 3.0);
        p.geometry.coordinate_mode = CoordinateMode::NegativeSpace;
        let (min, max) = p.machine_bounds();
        assert_eq!(min[0], -p.geometry.envelope.x);
        assert_eq!(max, [0.0, 0.0, 0.0]);
        p.geometry.coordinate_mode = CoordinateMode::PositiveSpace;
        let (min, max) = p.machine_bounds();
        assert_eq!(min[0], 0.0);
        assert_eq!(max[0], p.geometry.envelope.x);
        assert_eq!(min[2], -p.geometry.envelope.z);
        p.geometry.home_corner = HomeCorner::BackRight;
        assert_eq!(p.to_grbl_settings()[&23], 0.0);
    }

    #[test]
    fn laser_profile_maps_power_and_laser_mode() {
        let p = MachineProfile::from_json(&preset("generic-laser")).unwrap();
        let s = p.to_grbl_settings();
        assert_eq!(s[&32], 1.0);
        assert_eq!(s[&30], p.laser.max_power);
    }

    #[test]
    fn rotary_adds_a_axis_settings() {
        let p = MachineProfile::from_json(&preset("generic-rotary")).unwrap();
        let s = p.to_grbl_settings();
        assert!(s.contains_key(&103));
    }
}
