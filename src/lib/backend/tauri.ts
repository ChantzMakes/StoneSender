import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Backend, LinkEvent, LoadedJob } from './types';

export const tauriBackend: Backend = {
  kind: 'tauri',
  listProfiles: () => invoke('profiles_list'),
  saveProfile: (profile) => invoke('profile_save', { profile }),
  deleteProfile: (id) => invoke('profile_delete', { id }),
  loadAppSettings: () => invoke('app_settings_load'),
  saveAppSettings: (settings) => invoke('app_settings_save', { settings }),
  dataDir: () => invoke('data_dir'),

  async openTextFile({ title, filters }) {
    const path = await open({ title, filters, multiple: false, directory: false });
    if (typeof path !== 'string') return null;
    const text = await invoke<string>('text_file_read', { path });
    return { name: path.split(/[\\/]/).pop() ?? path, text };
  },
  async saveTextFile({ title, defaultName, filters, text }) {
    const path = await save({ title, defaultPath: defaultName, filters });
    if (!path) return false;
    await invoke('text_file_write', { path, contents: text });
    return true;
  },
  async saveBinaryFile({ title, defaultName, filters, bytes }) {
    const path = await save({ title, defaultPath: defaultName, filters });
    if (!path) return false;
    await invoke('binary_file_write', bytes, { headers: { path: encodeURIComponent(path) } });
    return true;
  },

  listPorts: () => invoke('list_ports'),
  connect: (req) => invoke('link_connect', { req }),
  disconnect: () => invoke('link_disconnect'),
  sendLine: (line) => invoke('link_send_line', { line }),
  sendTracked: (line, id) => invoke('link_send_tracked', { line, id }),
  sendRealtime: (byte) => invoke('link_send_realtime', { byte }),
  snapshot: () => invoke('link_snapshot'),
  injectFault: (fault) => invoke('virtual_inject_fault', { fault }),
  async onLinkEvent(cb) {
    return listen<LinkEvent>('link-event', (e) => cb(e.payload));
  },

  async openJob() {
    const path = await open({
      title: 'Open G-code',
      multiple: false,
      directory: false,
      filters: [{ name: 'G-code', extensions: ['nc', 'gcode', 'gc', 'ngc', 'tap', 'cnc', 'txt'] }],
    });
    if (typeof path !== 'string') return null;
    return tauriBackend.loadJobPath(path);
  },
  async loadJobPath(path) {
    const job = await invoke<LoadedJob>('job_load', { path });
    const text = await invoke<string>('text_file_read', { path });
    return { job, text };
  },
  loadJobText: (name, text) => invoke<LoadedJob>('job_load_text', { name, text }),
  jobStart: (mode, options) => invoke('job_start', { mode, options: options ?? null }),
  jobToolChangeDone: () => invoke('job_tool_change_done'),
  jobPause: () => invoke('job_pause'),
  jobResume: () => invoke('job_resume'),
  jobStop: () => invoke('job_stop'),
  jobUnload: () => invoke('job_unload'),
  jogStart: (dir, feed, accel) => invoke('jog_start', { dir, feed, accel }),
  jogHeartbeat: () => invoke('jog_heartbeat'),
  jogStop: () => invoke('jog_stop'),
  controllerRefresh: () => invoke('controller_refresh'),
};
