/**
 * App updates (Phase 8b): Tauri updater against GitHub Releases
 * (`latest.json` of the newest published release, signed with the project's
 * updater key — unsigned or tampered downloads are refused by the plugin).
 *
 * Safety decision: an update is never installed while connected to a
 * machine — installing quits and restarts the app, which would drop the
 * connection mid-job. Checking only reads github.com; nothing is downloaded
 * until the user clicks Install.
 */
import { create } from 'zustand';
import { isTauri } from '@/lib/backend';
import { errorMessage } from '@/lib/utils';
import { useLink } from './link';

export const APP_VERSION: string = __APP_VERSION__;
export const RELEASES_URL = 'https://github.com/ChantzMakes/StoneSender/releases';

type Status = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error';

interface UpdateStore {
  status: Status;
  version: string | null;
  notes: string | null;
  date: string | null;
  /** 0..1 while downloading (null when the size is unknown) */
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
  /** The banner was closed for this version */
  dismissed: string | null;
  check(opts?: { quiet?: boolean }): Promise<void>;
  install(): Promise<void>;
  dismiss(): void;
}

// The plugin's Update object (kept out of the store: it holds a native resource).
let pending: import('@tauri-apps/plugin-updater').Update | null = null;

export function canInstallNow(): { ok: boolean; reason?: string } {
  const link = useLink.getState();
  if (link.state !== 'disconnected') return { ok: false, reason: 'Disconnect from the machine first — installing restarts StoneSender.' };
  return { ok: true };
}

export const useUpdates = create<UpdateStore>((set, get) => ({
  status: 'idle',
  version: null,
  notes: null,
  date: null,
  progress: null,
  error: null,
  checkedAt: null,
  dismissed: null,
  async check({ quiet = false } = {}) {
    if (!isTauri) {
      if (!quiet) set({ status: 'error', error: 'Updates work in the installed app, not in the browser preview.' });
      return;
    }
    if (get().status === 'checking' || get().status === 'downloading' || get().status === 'installing') return;
    set({ status: 'checking', error: null });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const u = await check({ timeout: 15000 });
      pending = u;
      if (u) set({ status: 'available', version: u.version, notes: u.body ?? null, date: u.date ?? null, checkedAt: Date.now() });
      else set({ status: 'none', version: null, notes: null, checkedAt: Date.now() });
    } catch (e) {
      // A quiet background check (startup) stays quiet when offline.
      set({ status: quiet ? 'idle' : 'error', error: quiet ? null : `Could not check for updates: ${errorMessage(e)}`, checkedAt: Date.now() });
    }
  },
  async install() {
    const gate = canInstallNow();
    if (!gate.ok) {
      set({ error: gate.reason ?? null });
      return;
    }
    if (!pending) return;
    set({ status: 'downloading', progress: 0, error: null });
    try {
      let total = 0;
      let got = 0;
      await pending.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        else if (ev.event === 'Progress') {
          got += ev.data.chunkLength;
          set({ progress: total ? got / total : null });
        } else if (ev.event === 'Finished') set({ status: 'installing', progress: 1 });
      });
      // Windows quits during install; elsewhere restart into the new version.
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      set({ status: 'error', error: `The update could not be installed: ${errorMessage(e)}` });
    }
  },
  dismiss() {
    set({ dismissed: get().version });
  },
}));
