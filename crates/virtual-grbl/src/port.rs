//! Threaded wrapper: runs a [`VirtualGrbl`] in real time and exposes it as a
//! byte-stream transport, indistinguishable (to the link layer) from a serial
//! port.

use crate::machine::{Fault, Stats, VirtualConfig, VirtualGrbl};
use grbl_core::transport::{ByteReader, ByteWriter, TransportFactory, TransportPair};
use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

struct Shared {
    dev: Mutex<VirtualGrbl>,
    outbox: Mutex<VecDeque<u8>>,
    data_ready: Condvar,
    shutdown: AtomicBool,
}

/// Control handle for tests and the developer panel.
#[derive(Clone)]
pub struct VirtualHandle {
    shared: Arc<Shared>,
}

impl VirtualHandle {
    pub fn inject(&self, fault: Fault) {
        self.shared.dev.lock().expect("virtual device lock").inject(fault);
        self.shared.data_ready.notify_all();
    }
    pub fn stats(&self) -> Stats {
        self.shared.dev.lock().expect("virtual device lock").stats().clone()
    }
    pub fn machine_pos(&self) -> [f64; 4] {
        self.shared.dev.lock().expect("virtual device lock").machine_pos()
    }
    pub fn state_name(&self) -> String {
        self.shared.dev.lock().expect("virtual device lock").state_name()
    }
    pub fn shutdown(&self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.data_ready.notify_all();
    }
}

struct Reader {
    shared: Arc<Shared>,
}

impl ByteReader for Reader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.shared.dev.lock().expect("virtual device lock").is_disconnected() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "virtual device disconnected"));
        }
        let mut out = self.shared.outbox.lock().expect("outbox lock");
        if out.is_empty() {
            let (o, _) = self.shared.data_ready.wait_timeout(out, Duration::from_millis(50)).expect("outbox wait");
            out = o;
        }
        let n = buf.len().min(out.len());
        for (slot, b) in buf.iter_mut().zip(out.drain(..n)) {
            *slot = b;
        }
        Ok(n)
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
    }
}

struct Writer {
    shared: Arc<Shared>,
}

impl ByteWriter for Writer {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        let mut dev = self.shared.dev.lock().expect("virtual device lock");
        if dev.is_disconnected() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "virtual device disconnected"));
        }
        dev.receive(data);
        Ok(())
    }
}

/// Start a virtual controller on a background thread.
pub fn spawn(cfg: VirtualConfig) -> (TransportPair, VirtualHandle) {
    let scale = cfg.time_scale.max(0.01);
    let shared = Arc::new(Shared {
        dev: Mutex::new(VirtualGrbl::new(cfg)),
        outbox: Mutex::new(VecDeque::new()),
        data_ready: Condvar::new(),
        shutdown: AtomicBool::new(false),
    });
    let worker = shared.clone();
    thread::Builder::new()
        .name("virtual-grbl".into())
        .spawn(move || {
            let mut last = Instant::now();
            while !worker.shutdown.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(2));
                let now = Instant::now();
                let dt = (now - last).as_secs_f64() * scale;
                last = now;
                let bytes = {
                    let mut dev = worker.dev.lock().expect("virtual device lock");
                    // Cap a single step so a stalled thread doesn't teleport.
                    dev.step(dt.min(0.1));
                    dev.take_output()
                };
                if !bytes.is_empty() {
                    worker.outbox.lock().expect("outbox lock").extend(bytes);
                    worker.data_ready.notify_all();
                }
            }
        })
        .expect("spawn virtual-grbl thread");
    let pair = TransportPair {
        reader: Box::new(Reader { shared: shared.clone() }),
        writer: Box::new(Writer { shared: shared.clone() }),
        description: "Virtual GRBL".into(),
    };
    (pair, VirtualHandle { shared })
}

/// Opens a fresh virtual controller each time (like plugging in a board,
/// which resets it). Remembers the latest handle for fault injection.
pub struct VirtualFactory {
    cfg: VirtualConfig,
    last: Mutex<Option<VirtualHandle>>,
}

impl VirtualFactory {
    pub fn new(cfg: VirtualConfig) -> Self {
        VirtualFactory { cfg, last: Mutex::new(None) }
    }
    pub fn handle(&self) -> Option<VirtualHandle> {
        self.last.lock().expect("factory lock").clone()
    }
}

impl TransportFactory for VirtualFactory {
    fn open(&self) -> io::Result<TransportPair> {
        let (pair, handle) = spawn(self.cfg.clone());
        if let Some(old) = self.last.lock().expect("factory lock").replace(handle) {
            old.shutdown();
        }
        Ok(pair)
    }
    fn describe(&self) -> String {
        format!("Virtual GRBL ({:?})", self.cfg.flavor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::Flavor;

    fn read_until(r: &mut dyn ByteReader, needle: &str, timeout: Duration) -> String {
        let start = Instant::now();
        let mut acc = String::new();
        let mut buf = [0u8; 256];
        while start.elapsed() < timeout {
            let n = r.read(&mut buf).unwrap();
            acc.push_str(&String::from_utf8_lossy(&buf[..n]));
            if acc.contains(needle) {
                return acc;
            }
        }
        panic!("timed out waiting for {needle:?}; got {acc:?}");
    }

    #[test]
    fn threaded_port_round_trip_and_disconnect() {
        let mut cfg = VirtualConfig::new(Flavor::Grbl11);
        cfg.time_scale = 10.0;
        let (mut pair, handle) = spawn(cfg);
        read_until(pair.reader.as_mut(), "Grbl 1.1h", Duration::from_secs(2));
        pair.writer.write_all(b"G0 X-10\n").unwrap();
        read_until(pair.reader.as_mut(), "ok", Duration::from_secs(2));
        pair.writer.write_all(b"?").unwrap();
        read_until(pair.reader.as_mut(), "<", Duration::from_secs(2));
        let start = Instant::now();
        while handle.state_name() != "Idle" && start.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!((handle.machine_pos()[0] + 10.0).abs() < 1e-6);
        handle.inject(Fault::Disconnect);
        let mut buf = [0u8; 16];
        assert!(pair.reader.read(&mut buf).is_err());
        assert!(pair.writer.write_all(b"?").is_err());
    }
}
