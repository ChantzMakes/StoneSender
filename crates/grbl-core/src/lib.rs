//! Shared, dependency-light building blocks used by the virtual device, the
//! link layer and the Tauri app.
//!
//! * [`profile`]   – Machine Profile types (serde mirror of the Zod schema in
//!   `src/lib/profile/schema.ts`) plus validation and the profile → `$$` mapping.
//! * [`protocol`]  – classification of every line GRBL can send us.
//! * [`status`]    – status report (`<...>`) parsing and a WCO-caching tracker.
//! * [`firmware`]  – firmware identification from welcome / `$I` output.
//! * [`transport`] – byte-stream traits every transport (serial, virtual) implements.

pub mod firmware;
pub mod gcode_prep;
pub mod profile;
pub mod protocol;
pub mod status;
pub mod transport;

/// GRBL real-time command bytes. These are never queued; they are written
/// straight to the port and acted on immediately by the controller.
pub mod realtime {
    pub const STATUS_REPORT: u8 = b'?';
    pub const CYCLE_START: u8 = b'~';
    pub const FEED_HOLD: u8 = b'!';
    pub const SOFT_RESET: u8 = 0x18;
    pub const SAFETY_DOOR: u8 = 0x84;
    pub const JOG_CANCEL: u8 = 0x85;
    pub const FEED_OVR_RESET: u8 = 0x90;
    pub const FEED_OVR_COARSE_PLUS: u8 = 0x91;
    pub const FEED_OVR_COARSE_MINUS: u8 = 0x92;
    pub const FEED_OVR_FINE_PLUS: u8 = 0x93;
    pub const FEED_OVR_FINE_MINUS: u8 = 0x94;
    pub const RAPID_OVR_RESET: u8 = 0x95;
    pub const RAPID_OVR_MEDIUM: u8 = 0x96;
    pub const RAPID_OVR_LOW: u8 = 0x97;
    pub const SPINDLE_OVR_RESET: u8 = 0x99;
    pub const SPINDLE_OVR_COARSE_PLUS: u8 = 0x9A;
    pub const SPINDLE_OVR_COARSE_MINUS: u8 = 0x9B;
    pub const SPINDLE_OVR_FINE_PLUS: u8 = 0x9C;
    pub const SPINDLE_OVR_FINE_MINUS: u8 = 0x9D;
    pub const SPINDLE_STOP_TOGGLE: u8 = 0x9E;
    pub const FLOOD_TOGGLE: u8 = 0xA0;
    pub const MIST_TOGGLE: u8 = 0xA1;

    /// True for any byte GRBL treats as a real-time command.
    pub fn is_realtime(b: u8) -> bool {
        matches!(b, STATUS_REPORT | CYCLE_START | FEED_HOLD | SOFT_RESET) || b >= 0x80
    }
}
