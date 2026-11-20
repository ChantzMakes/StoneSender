//! A software GRBL controller.
//!
//! [`VirtualGrbl`] is a deterministic state machine: feed it bytes with
//! [`VirtualGrbl::receive`], advance time with [`VirtualGrbl::step`] and
//! collect replies with [`VirtualGrbl::take_output`]. Tests drive it directly.
//!
//! [`port::spawn`] wraps it in a background thread that advances real time and
//! exposes it as a [`grbl_core::transport::TransportPair`], so the app connects
//! to it exactly like a serial port.
//!
//! Fidelity notes (what is and is not modelled) live in `AGENTS.md`.

mod gcode;
mod machine;
pub mod port;
mod settings;

pub use machine::{Fault, Flavor, ProbeBox, ProbeSurface, Stats, VirtualConfig, VirtualGrbl};
pub use port::{spawn, VirtualFactory, VirtualHandle};
