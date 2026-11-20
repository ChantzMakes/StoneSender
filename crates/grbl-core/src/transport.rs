//! Transport abstraction. A transport is a full-duplex byte stream split into
//! a reader half (owned by the reader thread) and a writer half (shared by the
//! command queue and real-time command senders).
//!
//! Implementations: `grbl_link::serial` (real ports via the `serialport`
//! crate) and `grbl_link::virtual_port` (the in-process GRBL emulator).

use serde::{Deserialize, Serialize};
use std::io;

pub trait ByteReader: Send {
    /// Read available bytes. Must return `Ok(0)` after a short timeout when no
    /// data arrives (so the caller can check for shutdown) and `Err` when the
    /// device is gone.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
}

pub trait ByteWriter: Send {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;
}

pub struct TransportPair {
    pub reader: Box<dyn ByteReader>,
    pub writer: Box<dyn ByteWriter>,
    pub description: String,
}

/// Something that can (re)open a transport. Kept separate from the open
/// connection so the link layer can auto-reconnect.
pub trait TransportFactory: Send + Sync {
    fn open(&self) -> io::Result<TransportPair>;
    fn describe(&self) -> String;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    /// OS path / name, e.g. `COM3`, `/dev/ttyUSB0`
    pub path: String,
    /// Human label, e.g. "USB-SERIAL CH340 (COM3)"
    pub label: String,
    pub kind: PortKind,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    /// Heuristic: common USB-serial chips used on GRBL boards
    pub likely_grbl: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortKind {
    Usb,
    Bluetooth,
    Pci,
    Unknown,
}

/// USB VID/PIDs commonly seen on GRBL controllers (Arduino, CH340, FTDI, CP210x, STM32 CDC).
pub fn likely_grbl_usb(vid: u16, pid: u16) -> bool {
    matches!(
        (vid, pid),
        (0x2341, _) // Arduino
            | (0x2A03, _) // Arduino.org
            | (0x1A86, 0x7523) | (0x1A86, 0x5523) // CH340/CH341
            | (0x0403, 0x6001) | (0x0403, 0x6015) // FTDI
            | (0x10C4, 0xEA60) // CP210x
            | (0x0483, 0x5740) // STM32 virtual COM (grblHAL)
            | (0x16C0, 0x0483) // Teensy (grblHAL)
            | (0x303A, _) // Espressif
    )
}
