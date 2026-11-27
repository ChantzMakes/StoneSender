/**
 * One-way status feed from the main window to the pop-out status window (owner decision:
 * the pop-out is display-only). The main window publishes a small snapshot a few times a
 * second; the pop-out only listens. Nothing here can send to the machine.
 *
 * Transport: Tauri events in the desktop app (the pop-out's capability only allows
 * listening), a BroadcastChannel in the browser preview. This module deliberately does
 * not import `lib/backend`, so the pop-out never creates a connection of its own.
 */
import { formatDuration } from '@/features/job/format';

export const STATUS_EVENT = 'status-snapshot';
export const STATUS_WINDOW = 'status';
const CHANNEL = 'stonesender-status';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface StatusJob {
  name: string;
  mode: 'run' | 'check';
  phase: string;
  acked: number;
  total: number;
  currentLine: number;
  elapsedMs: number;
  /** Planner estimate when known, else a line-rate estimate; null before the first line */
  remainingMs: number | null;
  /** 0–1, by planned time when known, else by lines */
  fraction: number;
}

export interface StatusSnapshot {
  v: 1;
  sentAt: number;
  /** The main window's appearance, so the pop-out matches it */
  theme: 'system' | 'dark' | 'light' | 'contrast';
  uiScale: number;
  connected: boolean;
  profileName: string | null;
  laser: boolean;
  units: 'mm' | 'inch';
  state: { name: string; sub?: number | string } | null;
  axes: string[];
  /** Work position in mm (A in degrees) */
  wpos: number[] | null;
  feed: number;
  spindle: number;
  overrides: { feed: number; rapid: number; spindle: number } | null;
  job: StatusJob | null;
}

/** Progress and time left, the same way the Job panel computes them. */
export function jobProgress(
  job: { acked: number; total: number; elapsedMs: number; currentLine: number; mode: 'run' | 'check' },
  active: boolean,
  plan: { totalS: number; remainingS: number | null } | null,
): { fraction: number; remainingMs: number | null } {
  const byLines = job.total > 0 ? job.acked / job.total : 0;
  if (job.mode === 'run' && plan && plan.remainingS !== null && plan.totalS > 0) {
    const remainingMs = active ? plan.remainingS * 1000 : 0;
    // Finished or stopped jobs keep the line fraction (a stop leaves it short of 100 %).
    const fraction = active ? Math.min(1, Math.max(0, 1 - plan.remainingS / plan.totalS)) : byLines;
    return { fraction, remainingMs: active ? remainingMs : null };
  }
  const remainingMs = active && job.acked > 0 ? (job.elapsedMs * (job.total - job.acked)) / job.acked : null;
  return { fraction: byLines, remainingMs };
}

export function formatRemaining(ms: number | null): string {
  return ms === null ? '—' : formatDuration(ms);
}

// ---------------------------------------------------------------------------
// Transport

let channel: BroadcastChannel | null = null;
function bc(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return (channel ??= new BroadcastChannel(CHANNEL));
}

export async function publishStatus(s: StatusSnapshot): Promise<void> {
  if (inTauri) {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(STATUS_EVENT, s);
  } else {
    bc()?.postMessage(s);
  }
}

export function subscribeStatus(cb: (s: StatusSnapshot) => void): () => void {
  if (inTauri) {
    let off: (() => void) | null = null;
    let cancelled = false;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<StatusSnapshot>(STATUS_EVENT, (e) => cb(e.payload)).then((un) => {
        if (cancelled) un();
        else off = un;
      }),
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }
  const c = bc();
  if (!c) return () => undefined;
  const on = (e: MessageEvent) => {
    if (e.data && e.data.v === 1) cb(e.data as StatusSnapshot);
  };
  c.addEventListener('message', on);
  return () => c.removeEventListener('message', on);
}

// ---------------------------------------------------------------------------
// Opening the window

export async function openStatusWindow(): Promise<void> {
  const url = `${window.location.pathname.replace(/[^/]*$/, '')}index.html?view=status`;
  if (inTauri) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(STATUS_WINDOW);
    if (existing) {
      await existing.unminimize().catch(() => undefined);
      await existing.setFocus();
      return;
    }
    const w = new WebviewWindow(STATUS_WINDOW, { url, title: 'StoneSender — Status', width: 560, height: 340, minWidth: 360, minHeight: 240, resizable: true });
    await new Promise<void>((resolve, reject) => {
      void w.once('tauri://created', () => resolve());
      void w.once('tauri://error', (e) => reject(new Error(String(e.payload))));
    });
    return;
  }
  window.open(url, 'stonesender-status', 'popup,width=560,height=340');
}
