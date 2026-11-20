/**
 * Render data for the 3D viewer, built in the worker.
 *
 * Output is one `LineSegments` buffer (vertex pairs) plus per-vertex
 * attributes the shader colours from: display kind, feed, laser power and the
 * planned time at that vertex. Colour mode, "completed vs remaining" and
 * playback are then just shader uniforms — no rebuild while scrubbing.
 *
 * Coordinates are the toolpath's (work zero = origin, see analyze.ts). The A
 * axis is ignored here; rotary wrapping is drawn by the machine simulator.
 */
import { pathFraction } from './planner';
import { ARC_FIELDS, MOTION_FIELDS, SEG, type Toolpath } from './toolpath';

/** Display kinds (shader `aKind`) */
export const DKIND = { rapid: 0, feed: 1, arc: 2, plunge: 3, probe: 4 } as const;

export interface RenderOptions {
  /** Laser: feed moves with power 0 are drawn as travel */
  laser?: boolean;
  /** Max chord error when drawing arcs (mm) */
  arcTolerance?: number;
  maxArcSegments?: number;
  /** Above this many line segments, merge tiny consecutive segments (level of detail) */
  lodThreshold?: number;
}

export interface RenderGeometry {
  vertexCount: number;
  positions: Float32Array;
  kind: Float32Array;
  feed: Float32Array;
  power: Float32Array;
  time: Float32Array;
  /** Cumulative planned time at the end of each toolpath segment */
  segEnd: Float64Array;
  /** True when level-of-detail merging was applied */
  decimated: boolean;
  /** Line segments before LOD merging */
  fullSegments: number;
}

const PLANES: [number, number, number][] = [
  [0, 1, 2],
  [2, 0, 1],
  [1, 2, 0],
];

function arcPieces(radius: number, angle: number, tol: number, max: number): number {
  if (radius <= tol) return 1;
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / radius));
  return Math.min(max, Math.max(1, Math.ceil(Math.abs(angle) / Math.max(step, 1e-6))));
}

/** Cumulative end time per segment (prefix sum of planned durations). */
export function segmentEndTimes(tp: Toolpath): Float64Array {
  const out = new Float64Array(tp.count);
  let acc = 0;
  for (let i = 0; i < tp.count; i++) {
    acc += tp.duration[i]!;
    out[i] = acc;
  }
  return out;
}

function displayKind(tp: Toolpath, i: number, laser: boolean, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): number {
  const k = tp.kind[i]!;
  if (k === SEG.rapid) return DKIND.rapid;
  if (k === SEG.probe) return DKIND.probe;
  if (laser && tp.spindle[i]! <= 0) return DKIND.rapid;
  if (k === SEG.arcCw || k === SEG.arcCcw) return DKIND.arc;
  const dz = ez - sz;
  const len = Math.hypot(ex - sx, ey - sy, dz);
  if (dz < 0 && -dz > 0.9 * len) return DKIND.plunge;
  return DKIND.feed;
}

export function buildRenderGeometry(tp: Toolpath, opts: RenderOptions = {}): RenderGeometry {
  const laser = opts.laser ?? false;
  const tol = opts.arcTolerance ?? 0.02;
  const maxArc = opts.maxArcSegments ?? 128;
  const lodThreshold = opts.lodThreshold ?? 2_000_000;
  const segEnd = segmentEndTimes(tp);

  // Pass 1: count line segments.
  let lines = 0;
  {
    let px = tp.origin[0]!,
      py = tp.origin[1]!,
      pz = tp.origin[2]!;
    for (let i = 0; i < tp.count; i++) {
      const k = tp.kind[i]!;
      const ex = tp.end[i * 4]!,
        ey = tp.end[i * 4 + 1]!,
        ez = tp.end[i * 4 + 2]!;
      if (k === SEG.dwell) continue;
      if (k === SEG.arcCw || k === SEG.arcCcw) {
        const a = tp.arcRef[i]! * ARC_FIELDS;
        const [a0, a1] = PLANES[tp.arcs[a + 4]!]!;
        const p = [px, py, pz];
        const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
        lines += arcPieces(Math.hypot(p[a0]! - c[a0]!, p[a1]! - c[a1]!), tp.arcs[a + 3]!, tol, maxArc);
      } else if (ex !== px || ey !== py || ez !== pz) {
        lines++;
      }
      px = ex;
      py = ey;
      pz = ez;
    }
  }
  const decimate = lines > lodThreshold;

  // Bounds for the LOD merge length.
  let minLen = 0;
  if (decimate) {
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tp.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = tp.end[i * 4 + k]!;
        lo[k] = Math.min(lo[k]!, v);
        hi[k] = Math.max(hi[k]!, v);
      }
    }
    const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
    minLen = diag / 3000;
    lo = hi = [];
  }

  const cap = lines * 2;
  const positions = new Float32Array(cap * 3);
  const kind = new Float32Array(cap);
  const feed = new Float32Array(cap);
  const power = new Float32Array(cap);
  const time = new Float32Array(cap);
  let v = 0;
  const emit = (ax: number, ay: number, az: number, at: number, bx: number, by: number, bz: number, bt: number, k: number, f: number, s: number) => {
    const o = v * 3;
    positions[o] = ax;
    positions[o + 1] = ay;
    positions[o + 2] = az;
    positions[o + 3] = bx;
    positions[o + 4] = by;
    positions[o + 5] = bz;
    kind[v] = kind[v + 1] = k;
    feed[v] = feed[v + 1] = f;
    power[v] = power[v + 1] = s;
    time[v] = at;
    time[v + 1] = bt;
    v += 2;
  };

  let px = tp.origin[0]!,
    py = tp.origin[1]!,
    pz = tp.origin[2]!;
  // Pending merged run (LOD)
  let run: { x: number; y: number; z: number; t: number; k: number; f: number; s: number; len: number } | null = null;
  const flushRun = (ex: number, ey: number, ez: number, et: number) => {
    if (run) emit(run.x, run.y, run.z, run.t, ex, ey, ez, et, run.k, run.f, run.s);
    run = null;
  };

  for (let i = 0; i < tp.count; i++) {
    const k = tp.kind[i]!;
    const ex = tp.end[i * 4]!,
      ey = tp.end[i * 4 + 1]!,
      ez = tp.end[i * 4 + 2]!;
    const t1 = segEnd[i]!;
    const t0 = t1 - tp.duration[i]!;
    if (k === SEG.dwell) continue;
    const f = tp.feed[i]!;
    const s = tp.spindle[i]!;
    const dk = displayKind(tp, i, laser, px, py, pz, ex, ey, ez);
    if (k === SEG.arcCw || k === SEG.arcCcw) {
      if (run) flushRun(px, py, pz, t0);
      const a = tp.arcRef[i]! * ARC_FIELDS;
      const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
      const angle = tp.arcs[a + 3]!;
      const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
      const start = [px, py, pz];
      const end = [ex, ey, ez];
      const r0 = start[a0]! - c[a0]!;
      const r1 = start[a1]! - c[a1]!;
      const n = arcPieces(Math.hypot(r0, r1), angle, tol, maxArc);
      let prev = start;
      let prevT = t0;
      for (let j = 1; j <= n; j++) {
        let p: number[];
        if (j === n) p = end;
        else {
          const th = (angle * j) / n;
          p = [0, 0, 0];
          p[a0] = c[a0]! + r0 * Math.cos(th) - r1 * Math.sin(th);
          p[a1] = c[a1]! + r0 * Math.sin(th) + r1 * Math.cos(th);
          p[lin] = start[lin]! + ((end[lin]! - start[lin]!) * j) / n;
        }
        const t = t0 + ((t1 - t0) * j) / n;
        emit(prev[0]!, prev[1]!, prev[2]!, prevT, p[0]!, p[1]!, p[2]!, t, dk, f, s);
        prev = p;
        prevT = t;
      }
    } else if (ex !== px || ey !== py || ez !== pz) {
      if (decimate) {
        const len = Math.hypot(ex - px, ey - py, ez - pz);
        if (run && (run.k !== dk || run.f !== f || run.s !== s)) flushRun(px, py, pz, t0);
        if (!run) run = { x: px, y: py, z: pz, t: t0, k: dk, f, s, len: 0 };
        run.len += len;
        if (run.len >= minLen) flushRun(ex, ey, ez, t1);
      } else {
        emit(px, py, pz, t0, ex, ey, ez, t1, dk, f, s);
      }
    }
    px = ex;
    py = ey;
    pz = ez;
  }
  if (run) flushRun(px, py, pz, segEnd[tp.count - 1] ?? 0);

  return {
    vertexCount: v,
    positions: v === cap ? positions : positions.slice(0, v * 3),
    kind: v === cap ? kind : kind.slice(0, v),
    feed: v === cap ? feed : feed.slice(0, v),
    power: v === cap ? power : power.slice(0, v),
    time: v === cap ? time : time.slice(0, v),
    segEnd,
    decimated: decimate,
    fullSegments: lines,
  };
}

export function renderTransferables(g: RenderGeometry): ArrayBuffer[] {
  return [g.positions, g.kind, g.feed, g.power, g.time, g.segEnd].map((a) => a.buffer as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Playback sampling
// ---------------------------------------------------------------------------

export interface Sample {
  /** x, y, z, a */
  pos: [number, number, number, number];
  /** toolpath segment index (−1 before the first move) */
  seg: number;
  /** source line (0 before the first move) */
  line: number;
}

/** Tool position at planned time `t` (seconds). */
export function sampleAt(tp: Toolpath, segEnd: Float64Array, t: number): Sample {
  const n = tp.count;
  if (n === 0 || t <= 0) return { pos: [tp.origin[0]!, tp.origin[1]!, tp.origin[2]!, tp.origin[3]!], seg: -1, line: n ? tp.line[0]! : 0 };
  // First segment whose end time ≥ t
  let lo = 0;
  let hi = n - 1;
  if (t >= segEnd[n - 1]!) lo = n - 1;
  else
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segEnd[mid]! >= t) hi = mid;
      else lo = mid + 1;
    }
  const i = lo;
  const dur = tp.duration[i]!;
  const timeFrac = dur > 0 ? Math.min(1, Math.max(0, (t - (segEnd[i]! - dur)) / dur)) : 1;
  const s = i === 0 ? [tp.origin[0]!, tp.origin[1]!, tp.origin[2]!, tp.origin[3]!] : [tp.end[(i - 1) * 4]!, tp.end[(i - 1) * 4 + 1]!, tp.end[(i - 1) * 4 + 2]!, tp.end[(i - 1) * 4 + 3]!];
  const e = [tp.end[i * 4]!, tp.end[i * 4 + 1]!, tp.end[i * 4 + 2]!, tp.end[i * 4 + 3]!];
  const k = tp.kind[i]!;
  const pos = [0, 0, 0, 0] as Sample['pos'];
  // Distance along the move follows the planned speed profile (accelerate, cruise, decelerate).
  let len: number;
  if (k === SEG.arcCw || k === SEG.arcCcw) {
    const a = tp.arcRef[i]! * ARC_FIELDS;
    const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
    const r = Math.hypot(s[a0]! - tp.arcs[a + a0]!, s[a1]! - tp.arcs[a + a1]!);
    len = Math.hypot(Math.abs(tp.arcs[a + 3]!) * r, e[lin]! - s[lin]!);
  } else {
    len = Math.hypot(e[0]! - s[0]!, e[1]! - s[1]!, e[2]! - s[2]!, e[3]! - s[3]!);
  }
  const mo = i * MOTION_FIELDS;
  const frac = tp.motion ? pathFraction(timeFrac, len, tp.motion[mo]!, tp.motion[mo + 1]!, tp.motion[mo + 2]!, tp.motion[mo + 3]!) : timeFrac;
  if (k === SEG.arcCw || k === SEG.arcCcw) {
    const a = tp.arcRef[i]! * ARC_FIELDS;
    const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
    const th = tp.arcs[a + 3]! * frac;
    const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
    const r0 = s[a0]! - c[a0]!;
    const r1 = s[a1]! - c[a1]!;
    pos[a0] = c[a0]! + r0 * Math.cos(th) - r1 * Math.sin(th);
    pos[a1] = c[a1]! + r0 * Math.sin(th) + r1 * Math.cos(th);
    pos[lin] = s[lin]! + (e[lin]! - s[lin]!) * frac;
    pos[3] = s[3]! + (e[3]! - s[3]!) * frac;
  } else {
    for (let k2 = 0; k2 < 4; k2++) pos[k2] = s[k2]! + (e[k2]! - s[k2]!) * frac;
  }
  return { pos, seg: i, line: tp.line[i]! };
}

/** Planned time at the *start* of a source line (for "jump to line"). */
export function timeAtLineStart(lineEndTime: Float64Array, line: number): number {
  if (line <= 1) return 0;
  return lineEndTime[Math.min(line - 1, lineEndTime.length - 1)] ?? 0;
}

// ---------------------------------------------------------------------------
// Snapping for the measuring tool
// ---------------------------------------------------------------------------

export class SnapIndex {
  private cells = new Map<number, number[]>();
  constructor(
    private pts: Float32Array,
    private cell: number,
  ) {
    for (let i = 0; i < pts.length / 3; i++) {
      const key = this.key(Math.floor(pts[i * 3]! / cell), Math.floor(pts[i * 3 + 1]! / cell));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }
  private key(cx: number, cy: number) {
    return (cx + 32768) * 65536 + (cy + 32768);
  }
  /** Nearest endpoint to (x, y) within `radius` (XY distance); null if none. */
  nearest(x: number, y: number, radius: number): [number, number, number] | null {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = -1;
    let bestD = radius * radius;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (const i of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          const d = (this.pts[i * 3]! - x) ** 2 + (this.pts[i * 3 + 1]! - y) ** 2;
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best < 0 ? null : [this.pts[best * 3]!, this.pts[best * 3 + 1]!, this.pts[best * 3 + 2]!];
  }
}

/** Snap index over the toolpath's segment endpoints (plus origin). */
export function buildSnapIndex(tp: Toolpath, cell = 2): SnapIndex {
  const pts = new Float32Array((tp.count + 1) * 3);
  pts.set([tp.origin[0]!, tp.origin[1]!, tp.origin[2]!], 0);
  for (let i = 0; i < tp.count; i++) pts.set([tp.end[i * 4]!, tp.end[i * 4 + 1]!, tp.end[i * 4 + 2]!], (i + 1) * 3);
  return new SnapIndex(pts, cell);
}

/** "Nice" ruler step (1, 2 or 5 × 10ⁿ) giving about `target` ticks over `span`. */
export function niceStep(span: number, target = 8): number {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------------------
// Segment geometry helpers (shared with the material-removal simulator)
// ---------------------------------------------------------------------------

/** Start point of segment i (x, y, z, a). */
export function segStartPoint(tp: Toolpath, i: number, out: number[] = [0, 0, 0, 0]): number[] {
  const src = i === 0 ? tp.origin : tp.end;
  const o = i === 0 ? 0 : (i - 1) * 4;
  for (let k = 0; k < 4; k++) out[k] = src[o + k]!;
  return out;
}

/** Length of segment i along its path (arcs: true arc length incl. helix; A counts as mm). */
export function segLength(tp: Toolpath, i: number): number {
  const s = segStartPoint(tp, i);
  const e = [tp.end[i * 4]!, tp.end[i * 4 + 1]!, tp.end[i * 4 + 2]!, tp.end[i * 4 + 3]!];
  const k = tp.kind[i]!;
  if (k === SEG.arcCw || k === SEG.arcCcw) {
    const a = tp.arcRef[i]! * ARC_FIELDS;
    const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
    const r = Math.hypot(s[a0]! - tp.arcs[a + a0]!, s[a1]! - tp.arcs[a + a1]!);
    return Math.hypot(Math.abs(tp.arcs[a + 3]!) * r, e[lin]! - s[lin]!);
  }
  return Math.hypot(e[0]! - s[0]!, e[1]! - s[1]!, e[2]! - s[2]!, e[3]! - s[3]!);
}

/** Path fraction (0–1) of segment i reached at planned time t, following its speed profile. */
export function fractionAt(tp: Toolpath, segEnd: Float64Array, i: number, t: number): number {
  const dur = tp.duration[i]!;
  if (dur <= 0) return t >= segEnd[i]! ? 1 : 0;
  const timeFrac = Math.min(1, Math.max(0, (t - (segEnd[i]! - dur)) / dur));
  const m = i * MOTION_FIELDS;
  return pathFraction(timeFrac, segLength(tp, i), tp.motion[m]!, tp.motion[m + 1]!, tp.motion[m + 2]!, tp.motion[m + 3]!);
}

/** Point at path fraction f of segment i (writes x, y, z, a into `out`). */
export function pointOnSegment(tp: Toolpath, i: number, f: number, start: number[], out: number[]): number[] {
  const e0 = tp.end[i * 4]!,
    e1 = tp.end[i * 4 + 1]!,
    e2 = tp.end[i * 4 + 2]!,
    e3 = tp.end[i * 4 + 3]!;
  const k = tp.kind[i]!;
  if (k === SEG.arcCw || k === SEG.arcCcw) {
    const a = tp.arcRef[i]! * ARC_FIELDS;
    const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
    const th = tp.arcs[a + 3]! * f;
    const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
    const r0 = start[a0]! - c[a0]!;
    const r1 = start[a1]! - c[a1]!;
    const e = [e0, e1, e2];
    out[a0] = c[a0]! + r0 * Math.cos(th) - r1 * Math.sin(th);
    out[a1] = c[a1]! + r0 * Math.sin(th) + r1 * Math.cos(th);
    out[lin] = start[lin]! + (e[lin]! - start[lin]!) * f;
    out[3] = start[3]! + (e3 - start[3]!) * f;
  } else {
    out[0] = start[0]! + (e0 - start[0]!) * f;
    out[1] = start[1]! + (e1 - start[1]!) * f;
    out[2] = start[2]! + (e2 - start[2]!) * f;
    out[3] = start[3]! + (e3 - start[3]!) * f;
  }
  return out;
}
