//! Tauri application shell: wires the link layer, the virtual device and
//! profile storage to IPC commands. Business logic lives in `crates/*`.

mod commands;
mod storage;

use grbl_link::{EventSink, Link, LinkEvent};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use virtual_grbl::VirtualFactory;

pub const LINK_EVENT: &str = "link-event";

struct TauriSink {
    app: AppHandle,
}

impl EventSink for TauriSink {
    fn emit(&self, event: LinkEvent) {
        if let Err(e) = self.app.emit(LINK_EVENT, &event) {
            log::warn!("failed to emit link event: {e}");
        }
    }
}

pub struct AppState {
    pub link: Link,
    /// The factory of the current virtual connection (for fault injection).
    pub virtual_factory: Mutex<Option<Arc<VirtualFactory>>>,
    pub storage: storage::Storage,
    /// Loaded job: (file name, full text)
    pub job_source: Mutex<Option<(String, String)>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let storage = storage::Storage::new(data_dir)?;
            let sink = Arc::new(TauriSink { app: app.handle().clone() });
            app.manage(AppState { link: Link::new(sink), virtual_factory: Mutex::new(None), storage, job_source: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            commands::link_connect,
            commands::link_disconnect,
            commands::link_send_line,
            commands::link_send_tracked,
            commands::link_send_realtime,
            commands::link_snapshot,
            commands::virtual_inject_fault,
            commands::profiles_list,
            commands::profile_save,
            commands::profile_delete,
            commands::app_settings_load,
            commands::app_settings_save,
            commands::text_file_read,
            commands::text_file_write,
            commands::binary_file_write,
            commands::job_load,
            commands::job_load_text,
            commands::job_start,
            commands::job_pause,
            commands::job_resume,
            commands::job_tool_change_done,
            commands::job_stop,
            commands::job_unload,
            commands::jog_start,
            commands::jog_heartbeat,
            commands::jog_stop,
            commands::controller_refresh,
            commands::data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
