/// <reference lib="webworker" />
/**
 * Material-removal worker.
 *
 * `init` runs the whole job once (with progress), storing keyframe snapshots
 * (as many as fit a memory budget), the problem list and island analysis.
 * `advance` then moves the simulation to any time: forward incrementally, or
 * back via the nearest keyframe. Only the changed rectangle is sent back.
 */
import type { Toolpath } from '@/lib/gcode/toolpath';
import { RemovalSim, type Grid, type RemovalConfig, type SimEvent, type SimSnapshot } from './removal';

export interface SimStats {
  removedVolume: number;
  minHeight: number;
  islands: number;
  totalTime: number;
  elapsedMs: number;
}

export type SimWorkerRequest =
  | { type: 'init'; id: number; toolpath: Toolpath; segEnd: Float64Array; cfg: RemovalConfig }
  | { type: 'advance'; id: number; t: number }
  | { type: 'full'; id: number };

export interface Patch {
  i0: number;
  j0: number;
  w: number;
  h: number;
  data: Float32Array;
  flags: Uint8Array;
}

export type SimWorkerResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'ready'; id: number; grid: Grid; events: SimEvent[]; stats: SimStats; initial: Patch }
  | { type: 'patch'; id: number; t: number; patch: Patch | null }
  | { type: 'full'; id: number; data: Float32Array; flags: Uint8Array }
  | { type: 'error'; id: number; message: string };

const KEYFRAME_BUDGET = 160_000_000;

let sim: RemovalSim | null = null;
let keyframes: SimSnapshot[] = [];
let keyGap = Infinity;
let finalState: { events: SimEvent[]; stats: SimStats } | null = null;
/** Largest island (mm²) still reported as a missed sliver */
let islandArea = 0;

const post = (m: SimWorkerResponse, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

function patchOf(s: RemovalSim, rect: [number, number, number, number] | null): Patch | null {
  if (!rect) return null;
  const [i0, j0, i1, j1] = rect;
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const data = new Float32Array(w * h);
  const flags = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const src = (j0 + j) * s.grid.nx + i0;
    data.set(s.data.subarray(src, src + w), j * w);
    flags.set(s.flags.subarray(src, src + w), j * w);
  }
  return { i0, j0, w, h, data, flags };
}

self.onmessage = (e: MessageEvent<SimWorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const t0 = performance.now();
      const s = new RemovalSim(m.toolpath, m.segEnd, m.cfg);
      const total = m.segEnd[m.segEnd.length - 1] ?? 0;
      const bytes = s.data.byteLength + s.flags.byteLength;
      const count = Math.max(2, Math.min(40, Math.floor(KEYFRAME_BUDGET / Math.max(bytes, 1))));
      keyGap = total / count;
      keyframes = [s.snapshot()];
      let last = 0;
      for (let k = 1; k <= count; k++) {
        const t = Math.min(total, k * keyGap);
        s.advanceTo(t);
        if (k < count) keyframes.push(s.snapshot());
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          post({ type: 'progress', id: m.id, fraction: k / count });
        }
      }
      s.advanceTo(total);
      const maxIsland = m.cfg.mode === 'router' ? Math.PI * Math.max(...m.cfg.tools.map((t) => (t.diameter / 2) ** 2), 1) * 4 : 0;
      islandArea = maxIsland;
      const islands = s.findIslands(maxIsland);
      for (const c of islands.centers) {
        s.events.push({ kind: 'island', line: 0, x: c[0], y: c[1], z: s.top, detail: 'Small island of material left inside a cut area' });
      }
      const stats: SimStats = {
        removedVolume: s.removedVolume,
        minHeight: s.minHeight(),
        islands: islands.count,
        totalTime: total,
        elapsedMs: performance.now() - t0,
      };
      finalState = { events: [...s.events], stats };
      sim = s;
      // Start the client at t = 0 (untouched stock).
      s.restore(keyframes[0]!);
      s.takeDirty();
      const initial = patchOf(s, [0, 0, s.grid.nx - 1, s.grid.ny - 1])!;
      post({ type: 'ready', id: m.id, grid: s.grid, events: finalState.events, stats, initial }, [initial.data.buffer, initial.flags.buffer]);
    } else if (m.type === 'advance') {
      const s = sim;
      if (!s) throw new Error('simulation not initialised');
      const t = Math.max(0, m.t);
      if (t < s.time - 1e-9 || t - s.time > keyGap * 1.5) {
        const k = Math.min(keyframes.length - 1, Math.floor(t / keyGap));
        const kf = keyframes[Math.max(0, k)]!;
        if (kf.time <= t && (t < s.time || kf.time > s.time)) s.restore(kf);
      }
      s.advanceTo(t);
      // Islands are only known for the finished job: show them at the end.
      if (finalState && t >= finalState.stats.totalTime - 1e-6 && finalState.stats.islands > 0) {
        s.findIslands(islandArea);
      }
      const p = patchOf(s, s.takeDirty());
      post({ type: 'patch', id: m.id, t, patch: p }, p ? [p.data.buffer, p.flags.buffer] : []);
    } else if (m.type === 'full') {
      const s = sim;
      if (!s) throw new Error('simulation not initialised');
      post({ type: 'full', id: m.id, data: s.data.slice(), flags: s.flags.slice() });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
