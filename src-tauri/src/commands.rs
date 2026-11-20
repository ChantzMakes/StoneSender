//! IPC commands. Thin wrappers; errors are returned as user-readable strings.

use crate::storage::write_atomic;
use crate::AppState;
use grbl_core::firmware::FirmwareKind;
use grbl_core::gcode_prep::{prepare, FirmwareCaps, JobScan};
use grbl_core::profile::MachineProfile;
use grbl_core::transport::{PortInfo, TransportFactory};
use grbl_link::serial::{list_ports as list_serial_ports, SerialFactory};
use grbl_link::{JobMode, LinkOptions, LinkSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use virtual_grbl::{Fault, Flavor, VirtualConfig, VirtualFactory};

#[tauri::command]
pub fn list_ports() -> Vec<PortInfo> {
    list_serial_ports()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectTarget {
    Serial { path: String, baud: u32 },
    Virtual { profile: Value, flavor: String, time_scale: Option<f64> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub target: ConnectTarget,
    pub poll_hz: f64,
    pub auto_reconnect: bool,
    #[serde(default = "default_true")]
    pub char_counting: bool,
    #[serde(default = "default_rx")]
    pub rx_buffer: usize,
}

fn default_true() -> bool {
    true
}
fn default_rx() -> usize {
    128
}

// `async` so the blocking port open runs off the main (UI) thread.
#[tauri::command(async)]
pub fn link_connect(state: State<'_, AppState>, req: ConnectRequest) -> Result<(), String> {
    let factory: Arc<dyn TransportFactory> = match req.target {
        ConnectTarget::Serial { path, baud } => {
            *state.virtual_factory.lock().map_err(|e| e.to_string())? = None;
            Arc::new(SerialFactory { path, baud })
        }
        ConnectTarget::Virtual { profile, flavor, time_scale } => {
            let profile = MachineProfile::from_value(profile).map_err(|e| e.to_string())?;
            let flavor = match flavor.as_str() {
                "grbl09" => Flavor::Grbl09,
                "grblhal" => Flavor::GrblHal,
                _ => Flavor::Grbl11,
            };
            let mut cfg = VirtualConfig::from_profile(&profile, flavor);
            cfg.time_scale = time_scale.unwrap_or(1.0).clamp(0.1, 100.0);
            let f = Arc::new(VirtualFactory::new(cfg));
            *state.virtual_factory.lock().map_err(|e| e.to_string())? = Some(f.clone());
            f
        }
    };
    let opts = LinkOptions {
        poll_hz: req.poll_hz,
        auto_reconnect: req.auto_reconnect,
        char_counting: req.char_counting,
        rx_buffer: req.rx_buffer.clamp(64, 16384),
        ..LinkOptions::default()
    };
    state.link.connect(factory, opts).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn link_disconnect(state: State<'_, AppState>) {
    state.link.disconnect();
}

#[tauri::command]
pub fn link_send_line(state: State<'_, AppState>, line: String) -> Result<(), String> {
    state.link.send_line(&line).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn link_send_realtime(state: State<'_, AppState>, byte: u8) -> Result<(), String> {
    state.link.send_realtime(byte).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn link_snapshot(state: State<'_, AppState>) -> LinkSnapshot {
    state.link.snapshot()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FaultRequest {
    Disconnect,
    Alarm { code: u16 },
    ErrorOnNextLine { code: u16 },
    DropNextOk,
    Stall { seconds: f64 },
}

/// Developer tool: inject a fault into the connected virtual controller.
#[tauri::command]
pub fn virtual_inject_fault(state: State<'_, AppState>, fault: FaultRequest) -> Result<(), String> {
    let guard = state.virtual_factory.lock().map_err(|e| e.to_string())?;
    let handle = guard.as_ref().and_then(|f| f.handle()).ok_or("not connected to a virtual controller")?;
    handle.inject(match fault {
        FaultRequest::Disconnect => Fault::Disconnect,
        FaultRequest::Alarm { code } => Fault::Alarm(code),
        FaultRequest::ErrorOnNextLine { code } => Fault::ErrorOnNextLine(code),
        FaultRequest::DropNextOk => Fault::DropNextOk,
        FaultRequest::Stall { seconds } => Fault::Stall(seconds),
    });
    Ok(())
}

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    state.storage.list_profiles()
}

#[tauri::command]
pub fn profile_save(state: State<'_, AppState>, profile: Value) -> Result<(), String> {
    state.storage.save_profile(profile)
}

#[tauri::command]
pub fn profile_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.storage.delete_profile(&id)
}

#[tauri::command]
pub fn app_settings_load(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    state.storage.load_app_settings()
}

#[tauri::command]
pub fn app_settings_save(state: State<'_, AppState>, settings: Value) -> Result<(), String> {
    state.storage.save_app_settings(&settings)
}

const TEXT_EXTENSIONS: &[&str] = &["json", "nc", "gcode", "gc", "ngc", "tap", "txt", "cnc", "csv"];
const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;

fn check_ext(path: &str) -> Result<(), String> {
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(format!("unsupported file type .{ext}"))
    }
}

/// Read a user-chosen text file (path comes from the native file dialog).
#[tauri::command(async)]
pub fn text_file_read(path: String) -> Result<String, String> {
    check_ext(&path)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err("file is too large".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write a user-chosen text file (path comes from the native save dialog).
#[tauri::command(async)]
pub fn text_file_write(path: String, contents: String) -> Result<(), String> {
    check_ext(&path)?;
    write_atomic(std::path::Path::new(&path), &contents).map_err(|e| e.to_string())
}

// ----- jobs -------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedJob {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub scan: JobScan,
}

fn current_caps(state: &AppState) -> FirmwareCaps {
    let snap = state.link.snapshot();
    let hal = snap.controller.build.grblhal || snap.firmware.as_ref().is_some_and(|f| f.kind == FirmwareKind::Grblhal);
    if hal {
        FirmwareCaps::GRBLHAL
    } else {
        FirmwareCaps::GRBL11
    }
}

/// Read and scan a G-code file. The text is kept in memory; it is
/// re-prepared for the connected firmware when the job starts.
#[tauri::command(async)]
pub fn job_load(state: State<'_, AppState>, path: String) -> Result<LoadedJob, String> {
    check_ext(&path)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err("file is too large".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (_, scan) = prepare(&text, &current_caps(&state));
    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
    *state.job_source.lock().map_err(|e| e.to_string())? = Some((name.clone(), text));
    Ok(LoadedJob { name, path, size_bytes: meta.len(), scan })
}

/// Same as `job_load` but for text that is already in the UI (browser drop, editor).
#[tauri::command(async)]
pub fn job_load_text(state: State<'_, AppState>, name: String, text: String) -> Result<LoadedJob, String> {
    let (_, scan) = prepare(&text, &current_caps(&state));
    let size = text.len() as u64;
    *state.job_source.lock().map_err(|e| e.to_string())? = Some((name.clone(), text));
    Ok(LoadedJob { name, path: String::new(), size_bytes: size, scan })
}

#[tauri::command]
pub fn job_start(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let (name, text) = state.job_source.lock().map_err(|e| e.to_string())?.clone().ok_or("no job loaded")?;
    let (lines, scan) = prepare(&text, &current_caps(&state));
    if scan.has_errors() {
        return Err("the job contains lines the controller would reject — see the pre-flight check".into());
    }
    if lines.is_empty() {
        return Err("the job has nothing to send".into());
    }
    let mode = if mode == "check" { JobMode::Check } else { JobMode::Run };
    state.link.start_job(name, lines, mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_pause(state: State<'_, AppState>) -> Result<(), String> {
    state.link.pause_job().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_resume(state: State<'_, AppState>) -> Result<(), String> {
    state.link.resume_job().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.link.stop_job().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn job_unload(state: State<'_, AppState>) -> Result<(), String> {
    *state.job_source.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

// ----- jogging & controller ------------------------------------------------------

#[tauri::command]
pub fn jog_start(state: State<'_, AppState>, dir: [f64; 3], feed: f64, accel: f64) -> Result<(), String> {
    state.link.jog_start(dir, feed, accel).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn jog_heartbeat(state: State<'_, AppState>) {
    state.link.jog_heartbeat();
}

#[tauri::command]
pub fn jog_stop(state: State<'_, AppState>) {
    state.link.jog_stop();
}

#[tauri::command]
pub fn controller_refresh(state: State<'_, AppState>) -> Result<(), String> {
    state.link.refresh_controller().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn data_dir(state: State<'_, AppState>) -> String {
    state.storage.root().display().to_string()
}
