//! Real serial ports via the `serialport` crate.

use grbl_core::transport::{likely_grbl_usb, ByteReader, ByteWriter, PortInfo, PortKind, TransportFactory, TransportPair};
use serialport::{SerialPort, SerialPortType};
use std::io::{self, Read, Write};
use std::time::Duration;

pub fn list_ports() -> Vec<PortInfo> {
    let ports = match serialport::available_ports() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("listing serial ports failed: {e}");
            return Vec::new();
        }
    };
    let mut out: Vec<PortInfo> = ports
        .into_iter()
        .map(|p| match p.port_type {
            SerialPortType::UsbPort(u) => {
                let name = u.product.clone().or(u.manufacturer.clone()).unwrap_or_else(|| "USB serial".into());
                PortInfo {
                    label: format!("{name} ({})", p.port_name),
                    path: p.port_name,
                    kind: PortKind::Usb,
                    vid: Some(u.vid),
                    pid: Some(u.pid),
                    manufacturer: u.manufacturer,
                    likely_grbl: likely_grbl_usb(u.vid, u.pid),
                }
            }
            SerialPortType::BluetoothPort => PortInfo {
                label: format!("Bluetooth ({})", p.port_name),
                path: p.port_name,
                kind: PortKind::Bluetooth,
                vid: None,
                pid: None,
                manufacturer: None,
                likely_grbl: false,
            },
            SerialPortType::PciPort => PortInfo {
                label: p.port_name.clone(),
                path: p.port_name,
                kind: PortKind::Pci,
                vid: None,
                pid: None,
                manufacturer: None,
                likely_grbl: false,
            },
            SerialPortType::Unknown => PortInfo {
                label: p.port_name.clone(),
                path: p.port_name,
                kind: PortKind::Unknown,
                vid: None,
                pid: None,
                manufacturer: None,
                likely_grbl: false,
            },
        })
        .collect();
    out.sort_by(|a, b| b.likely_grbl.cmp(&a.likely_grbl).then(a.path.cmp(&b.path)));
    out
}

pub struct SerialFactory {
    pub path: String,
    pub baud: u32,
}

impl TransportFactory for SerialFactory {
    fn open(&self) -> io::Result<TransportPair> {
        let port = serialport::new(&self.path, self.baud)
            .timeout(Duration::from_millis(50))
            .dtr_on_open(true)
            .open()
            .map_err(io::Error::other)?;
        let writer = port.try_clone().map_err(io::Error::other)?;
        Ok(TransportPair {
            reader: Box::new(SerialReader { port }),
            writer: Box::new(SerialWriter { port: writer }),
            description: format!("{} @ {} baud", self.path, self.baud),
        })
    }
    fn describe(&self) -> String {
        format!("{} @ {} baud", self.path, self.baud)
    }
}

struct SerialReader {
    port: Box<dyn SerialPort>,
}

impl ByteReader for SerialReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.port.read(buf) {
            Ok(0) => Ok(0),
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::TimedOut || e.kind() == io::ErrorKind::WouldBlock => Ok(0),
            Err(e) => Err(e),
        }
    }
}

struct SerialWriter {
    port: Box<dyn SerialPort>,
}

impl ByteWriter for SerialWriter {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        self.port.write_all(data)?;
        self.port.flush()
    }
}
