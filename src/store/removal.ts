/**
 * Material-removal simulation state. The worker client and the full grid
 * buffers live at module level so they survive the 3D view unmounting when
 * another tab is shown; React only sees small status fields and a version
 * counter that bumps when a patch arrives.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { AnalysisResult } from '@/lib/gcode/client';
import type { MachineProfile } from '@/lib/profile/schema';
import { type Patch, SimClient, type SimStats } from '@/lib/sim/client';
import type { Grid, RemovalConfig, SimEvent, SimMode } from '@/lib/sim/removal';
import { type Box3, stockBox, type StockSetup } from '@/lib/sim/setup';
import type { Tool } from '@/lib/sim/tools';
import { errorMessage } from '@/lib/utils';
import { useAnalysis } from './analysis';
import { useApp } from './app';
import { isActivePhase, useLink } from './link';
import { useSim } from './sim';

interface RemovalStore {
  status: 'idle' | 'running' | 'ready' | 'error';
  progress: number;
  error: string | null;
  mode: SimMode | null;
  grid: Grid | null;
  events: SimEvent[];
  stats: SimStats | null;
  /** bumps whenever `buffers` change */
  version: number;
  /** Planned time the buffers currently show */
  shownTime: number;
}

export const useRemoval = create<RemovalStore>(() => ({ status: 'idle', progress: 0, error: null, mode: null, grid: null, events: [], stats: null, version: 0, shownTime: 0 }));

/** Full grid on the main thread + the last patch (for partial mesh updates). */
export const buffers: { data: Float32Array | null; flags: Uint8Array | null; lastPatch: Patch | null; full: boolean; config: RemovalConfig | null; stock: Box3 | null } = {
  stock: null,
  data: null,
  flags: null,
  lastPatch: null,
  full: true,
  config: null,
};

let client: SimClient | null = null;
let currentKey: string | null = null;
const analysisIds = new WeakMap<object, number>();
let nextAnalysisId = 1;

function analysisId(a: AnalysisResult): number {
  let id = analysisIds.get(a);
  if (!id) {
    id = nextAnalysisId++;
    analysisIds.set(a, id);
  }
  return id;
}

export function simMode(p: MachineProfile): SimMode {
  return p.machineType === 'laser' ? 'laser' : p.machineType === 'rotary' ? 'rotary' : 'router';
}

/** Automatic grid resolution: finer for small jobs and lasers. */
export function autoResolution(mode: SimMode, area: number): number {
  const target = mode === 'laser' ? 1_000_000 : 600_000;
  const r = Math.sqrt(area / target);
  return mode === 'laser' ? Math.min(0.5, Math.max(0.1, r)) : Math.min(1, Math.max(0.1, r));
}

/**
 * Simulation config for the active profile. Lasers only simulate the area the
 * job burns (clipped to the stock) so the grid can be fine enough for raster
 * line spacing; the rest of the sheet is drawn plain.
 */
export function removalConfig(
  profile: MachineProfile,
  stock: StockSetup,
  tools: Tool[],
  jobTools: Record<number, string>,
  defaultToolId: string | null,
  resolution: number,
  cutBounds?: { empty: boolean; min: ArrayLike<number>; max: ArrayLike<number> },
): RemovalConfig {
  const mode = simMode(profile);
  const box = stockBox(stock);
  if (mode === 'laser' && cutBounds && !cutBounds.empty) {
    const m = 1;
    const lo = [Math.max(box.min[0], cutBounds.min[0]! - m), Math.max(box.min[1], cutBounds.min[1]! - m)];
    const hi = [Math.min(box.max[0], cutBounds.max[0]! + m), Math.min(box.max[1], cutBounds.max[1]! + m)];
    if (hi[0]! > lo[0]! && hi[1]! > lo[1]!) {
      box.min = [lo[0]!, lo[1]!, box.min[2]];
      box.max = [hi[0]!, hi[1]!, box.max[2]];
    }
  }
  const area = mode === 'rotary' ? stock.size.x * Math.PI * profile.rotary.defaultStockDiameter : (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]);
  const res = resolution > 0 ? resolution : autoResolution(mode, area);
  if (mode === 'rotary') {
    const r = profile.rotary.defaultStockDiameter / 2;
    return {
      mode,
      stockMin: [0, -r, -r],
      stockMax: [stock.size.x, r, r],
      rotaryRadius: r,
      ySubstitutionPerRev: profile.rotary.mode === 'y-substitution' ? profile.rotary.yMmPerRevolution : null,
      resolution: res,
      tools,
      jobTools,
      defaultToolId,
      laserMaxPower: profile.laser.maxPower,
    };
  }
  return { mode, stockMin: box.min, stockMax: box.max, resolution: res, tools, jobTools, defaultToolId, laserMaxPower: profile.laser.maxPower, laserSpot: 0.2 };
}

function applyPatch(t: number, p: Patch | null) {
  const g = useRemoval.getState().grid;
  if (p && g && buffers.data && buffers.flags) {
    for (let j = 0; j < p.h; j++) {
      const dst = (p.j0 + j) * g.nx + p.i0;
      buffers.data.set(p.data.subarray(j * p.w, (j + 1) * p.w), dst);
      buffers.flags.set(p.flags.subarray(j * p.w, (j + 1) * p.w), dst);
    }
    buffers.lastPatch = p;
    useRemoval.setState((s) => ({ version: s.version + 1, shownTime: t }));
  } else {
    useRemoval.setState({ shownTime: t });
  }
}

/** Planned time the removal should show: live job progress, else the playback position. */
function targetTime(): number {
  const a = useAnalysis.getState().result;
  const job = useLink.getState().job;
  if (a && job && isActivePhase(job.phase) && job.mode === 'run') {
    return a.lineEndTime[Math.min(job.currentLine, a.lineEndTime.length - 1)] ?? 0;
  }
  return useSim.getState().time;
}

/** Mount in the 3D view: keeps the simulation in sync with its inputs and with playback. */
export function useRemovalSync(profile: MachineProfile, stock: StockSetup) {
  const analysis = useAnalysis((s) => s.result);
  const tools = useApp((s) => s.settings.tools);
  const resolution = useApp((s) => s.settings.simResolution);
  const jobTools = useSim((s) => s.jobTools);
  const defaultToolId = useSim((s) => s.defaultToolId);
  const enabled = useSim((s) => s.showRemoval);

  const key = analysis && enabled ? JSON.stringify([analysisId(analysis), profile.id, profile.updatedAt, stock, tools, jobTools, defaultToolId, resolution]) : null;

  useEffect(() => {
    if (key === currentKey) return;
    currentKey = key;
    if (!key || !analysis) {
      useRemoval.setState({ status: 'idle', grid: null, events: [], stats: null, mode: null });
      buffers.data = buffers.flags = null;
      return;
    }
    client?.dispose();
    const c = new SimClient();
    client = c;
    const cfg = removalConfig(profile, stock, tools, jobTools, defaultToolId ?? tools[0]?.id ?? null, resolution, analysis.stats.cutBounds);
    buffers.config = cfg;
    buffers.stock = stockBox(stock);
    useRemoval.setState({ status: 'running', progress: 0, error: null, mode: cfg.mode });
    c.onProgress = (f) => useRemoval.setState({ progress: f });
    c.onPatch = (t, p) => {
      if (client === c) applyPatch(t, p);
    };
    c.init(analysis.toolpath, analysis.render.segEnd, cfg)
      .then((r) => {
        if (client !== c) return;
        const n = r.grid.nx * r.grid.ny;
        buffers.data = new Float32Array(n);
        buffers.flags = new Uint8Array(n);
        buffers.full = true;
        useRemoval.setState({ status: 'ready', grid: r.grid, events: r.events, stats: r.stats, progress: 1 });
        applyPatch(0, r.initial);
        c.advance(targetTime());
      })
      .catch((e) => {
        if (client === c) useRemoval.setState({ status: 'error', error: errorMessage(e) });
      });
  }, [key]);

  // Follow playback / the live job (throttled).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = -1;
    const kick = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (useRemoval.getState().status !== 'ready' || !client) return;
        const t = targetTime();
        if (Math.abs(t - last) < 1e-6) return;
        last = t;
        client.advance(t);
      }, 60);
    };
    const unsubs = [useSim.subscribe(kick), useLink.subscribe(kick), useRemoval.subscribe((s, prev) => s.status !== prev.status && kick())];
    kick();
    return () => {
      unsubs.forEach((u) => u());
      if (timer) clearTimeout(timer);
    };
  }, []);
}

/** Full current grid from the worker (for exports). */
export async function fullGrid(): Promise<{ grid: Grid; data: Float32Array; flags: Uint8Array } | null> {
  const g = useRemoval.getState().grid;
  if (!client || !g) return null;
  const r = await client.full();
  return { grid: g, ...r };
}
