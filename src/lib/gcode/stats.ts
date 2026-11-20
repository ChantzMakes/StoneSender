/** Job statistics from an interpreted + planned toolpath. */
import { ARC_FIELDS, SEG, type Toolpath } from './toolpath';
import type { Vec4 } from './interpreter';

export interface Bounds {
  min: [number, number, number, number];
  max: [number, number, number, number];
  empty: boolean;
}

export interface ToolUse {
  tool: number;
  firstLine: number;
  cutDistance: number;
  cutSeconds: number;
}

export interface JobStats {
  segments: number;
  arcs: number;
  /** All motion, machine coordinates */
  machineBounds: Bounds;
  /** All motion, work coordinates (of the WCS active at the start) */
  workBounds: Bounds;
  /** Cutting moves only (feed/arc/probe), work coordinates */
  cutBounds: Bounds;
  /** Deepest cutting Z in work coordinates (null if no cutting moves) */
  minCutZ: number | null;
  feedRange: [number, number] | null;
  spindleRange: [number, number] | null;
  distance: { rapid: number; cut: number };
  time: { total: number; rapid: number; cut: number; dwell: number };
  tools: ToolUse[];
  usesA: boolean;
}

function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity, -Infinity], empty: true };
}

function grow(b: Bounds, p: ArrayLike<number>) {
  for (let k = 0; k < 4; k++) {
    const v = p[k]!;
    if (v < b.min[k]!) b.min[k] = v;
    if (v > b.max[k]!) b.max[k] = v;
  }
  b.empty = false;
}

const PLANES: [number, number, number][] = [
  [0, 1, 2],
  [2, 0, 1],
  [1, 2, 0],
];

export function computeStats(tp: Toolpath, startWorkOffset: Vec4): JobStats {
  const machine = emptyBounds();
  const cutM = emptyBounds();
  const prev = [tp.origin[0]!, tp.origin[1]!, tp.origin[2]!, tp.origin[3]!];
  const end = [0, 0, 0, 0];
  let fMin = Infinity;
  let fMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  const dist = { rapid: 0, cut: 0 };
  const time = { total: 0, rapid: 0, cut: 0, dwell: 0 };
  const tools = new Map<number, ToolUse>();
  let usesA = false;

  for (let i = 0; i < tp.count; i++) {
    const kind = tp.kind[i]!;
    for (let k = 0; k < 4; k++) end[k] = tp.end[i * 4 + k]!;
    const d = tp.duration[i]!;
    time.total += d;
    if (kind === SEG.dwell) {
      time.dwell += d;
      continue;
    }
    if (end[3] !== prev[3]) usesA = true;
    const cutting = kind !== SEG.rapid;
    let len: number;
    const pts: number[][] = [end];
    if (kind === SEG.arcCw || kind === SEG.arcCcw) {
      const a = tp.arcRef[i]! * ARC_FIELDS;
      const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
      const angle = tp.arcs[a + 3]!;
      const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
      const r0 = prev[a0]! - c[a0]!;
      const r1 = prev[a1]! - c[a1]!;
      const radius = Math.hypot(r0, r1);
      const linear = end[lin]! - prev[lin]!;
      len = Math.hypot(Math.abs(angle) * radius, linear);
      // Sample every ~10° so bounds include the arc's bulge.
      const steps = Math.max(2, Math.ceil(Math.abs(angle) / (Math.PI / 18)));
      for (let s = 1; s < steps; s++) {
        const th = (angle * s) / steps;
        const p = [...prev];
        p[a0] = c[a0]! + r0 * Math.cos(th) - r1 * Math.sin(th);
        p[a1] = c[a1]! + r0 * Math.sin(th) + r1 * Math.cos(th);
        p[lin] = prev[lin]! + (linear * s) / steps;
        pts.push(p);
      }
    } else {
      len = Math.hypot(end[0]! - prev[0]!, end[1]! - prev[1]!, end[2]! - prev[2]!, end[3]! - prev[3]!);
    }
    grow(machine, prev);
    for (const p of pts) grow(machine, p);
    if (cutting) {
      grow(cutM, prev);
      for (const p of pts) grow(cutM, p);
      const f = tp.feed[i]!;
      if (f < fMin) fMin = f;
      if (f > fMax) fMax = f;
      dist.cut += len;
      time.cut += d;
      const t = tp.tool[i]!;
      const use = tools.get(t) ?? { tool: t, firstLine: tp.line[i]!, cutDistance: 0, cutSeconds: 0 };
      use.cutDistance += len;
      use.cutSeconds += d;
      tools.set(t, use);
    } else {
      dist.rapid += len;
      time.rapid += d;
    }
    const s = tp.spindle[i]!;
    if (s > 0) {
      if (s < sMin) sMin = s;
      if (s > sMax) sMax = s;
    }
    for (let k = 0; k < 4; k++) prev[k] = end[k]!;
  }

  const toWork = (b: Bounds): Bounds =>
    b.empty
      ? b
      : {
          min: b.min.map((v, k) => v - startWorkOffset[k]!) as Bounds['min'],
          max: b.max.map((v, k) => v - startWorkOffset[k]!) as Bounds['max'],
          empty: false,
        };
  const cut = toWork(cutM);
  return {
    segments: tp.count,
    arcs: tp.arcCount,
    machineBounds: machine,
    workBounds: toWork(machine),
    cutBounds: cut,
    minCutZ: cut.empty ? null : cut.min[2],
    feedRange: fMin === Infinity ? null : [fMin, fMax],
    spindleRange: sMin === Infinity ? null : [sMin, sMax],
    distance: dist,
    time,
    tools: [...tools.values()].sort((a, b) => a.firstLine - b.firstLine),
    usesA,
  };
}
