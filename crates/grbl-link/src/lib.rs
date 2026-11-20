//! Transport implementations and the connection manager ([`link::Link`]).
//!
//! Kept free of Tauri so it can be tested headlessly against the virtual
//! device; the app forwards [`link::LinkEvent`]s to the webview.

pub mod link;
pub mod sender;
pub mod serial;

pub use link::{ControllerInfo, EventSink, Link, LinkError, LinkEvent, LinkOptions, LinkSnapshot, LinkState};
pub use sender::{JobMode, JobPhase, JobProgress};
