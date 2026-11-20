/**
 * One-shot analysis: interpret → plan → stats. Pure; used by the worker and
 * directly by tests.
 */
import type { MachineProfile } from '@/lib/profile/schema';
import { interpret, type Diagnostic, type InterpretOptions, type Offsets, type ToolChangeInfo, type Vec4 } from './interpreter';
import { plan, plannerConfig, type PlannerConfig } from './planner';
import { computeStats, type JobStats } from './stats';
import type { Toolpath } from './toolpath';

export interface AnalyzeInput {
  text: string;
  profile: MachineProfile;
  /** `$$` values from the controller (override profile values for timing) */
  controllerSettings?: Record<string, string>;
  /** `$#` offsets from the controller (machine coordinates) */
  controllerOffsets?: Record<string, number[]>;
  /** Active WCS from `$G` (e.g. "G55") */
  activeWcs?: string;
  /** Current machine position, if known */
  machinePosition?: number[];
  plannerBlocks?: number | null;
}

export interface AnalyzeResult {
  toolpath: Toolpath;
  diagnostics: Diagnostic[];
  diagnosticsTruncated: number;
  toolChanges: ToolChangeInfo[];
  pauses: number[];
  sourceLines: number;
  stats: JobStats;
  lineEndTime: Float64Array;
  startWorkOffset: Vec4;
  planner: PlannerConfig;
  checkpoints: import('./interpreter').Checkpoint[];
  usesMachineCoords: boolean;
  changesOffsets: boolean;
  /** True when real controller offsets were used (bounds in machine space are meaningful) */
  offsetsKnown: boolean;
  elapsedMs: number;
}

const v4 = (a: number[] | undefined): Vec4 => [a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0, a?.[3] ?? 0];

export function offsetsFromController(o: Record<string, number[]> | undefined): Partial<Offsets> | undefined {
  if (!o || !o.G54) return undefined;
  return {
    wcs: ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].map((k) => v4(o[k])),
    g92: v4(o.G92),
    tlo: o.TLO?.[0] ?? 0,
    g28: v4(o.G28),
    g30: v4(o.G30),
  };
}

export function interpretOptions(input: Omit<AnalyzeInput, 'text'>): InterpretOptions {
  const offsets = offsetsFromController(input.controllerOffsets);
  const laserMode = input.controllerSettings?.['32'] !== undefined ? input.controllerSettings['32'] === '1' : input.profile.machineType === 'laser';
  const wcs = (input.activeWcs ?? 'G54') as 'G54';
  let start = input.machinePosition ? v4(input.machinePosition) : undefined;
  if (!start && offsets?.wcs) {
    // Unknown position: assume the tool waits above work zero.
    const idx = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].indexOf(wcs);
    start = [...offsets.wcs[Math.max(0, idx)]!] as Vec4;
  }
  return {
    offsets,
    start,
    modal: { wcs },
    laserMode,
    aAxis: input.profile.machineType === 'rotary' && input.profile.rotary.mode === 'a-axis',
  };
}

export function analyze(input: AnalyzeInput, onProgress?: (stage: string, fraction: number) => void): AnalyzeResult {
  const t0 = performance.now();
  const opts = interpretOptions(input);
  const r = interpret(input.text, opts, (done, total) => onProgress?.('Reading G-code', done / Math.max(total, 1)));
  onProgress?.('Estimating time', 0);
  const cfg = plannerConfig(input.profile, input.controllerSettings, input.plannerBlocks);
  const planned = plan(r.toolpath, cfg, r.sourceLines);
  onProgress?.('Measuring', 0);
  const stats = computeStats(r.toolpath, r.startWorkOffset);
  return {
    toolpath: r.toolpath,
    diagnostics: r.diagnostics,
    diagnosticsTruncated: r.diagnosticsTruncated,
    toolChanges: r.toolChanges,
    pauses: r.pauses,
    sourceLines: r.sourceLines,
    stats,
    lineEndTime: planned.lineEndTime,
    startWorkOffset: r.startWorkOffset,
    planner: cfg,
    checkpoints: r.checkpoints,
    usesMachineCoords: r.usesMachineCoords,
    changesOffsets: r.changesOffsets,
    offsetsKnown: !!opts.offsets,
    elapsedMs: performance.now() - t0,
  };
}
