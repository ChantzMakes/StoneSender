/**
 * Motion planner model / time estimator.
 *
 * Mirrors GRBL 1.1's planner (`planner.c`):
 *  - per-block nominal speed and acceleration limited per axis along the move
 *    direction (`limit_value_by_axis_maximum`)
 *  - junction speed from junction deviation ($11), capped by both blocks'
 *    nominal speeds
 *  - arcs split into chords like `mc_arc` (arc tolerance $12)
 *  - look-ahead limited to the controller's planner size: GRBL can only plan
 *    across the blocks it has buffered and must be able to stop at the end of
 *    the last one, which caps speed on short segments
 *  - spindle/coolant changes, dwells, probes and M0 empty the planner (the
 *    machine comes to a stop)
 *  - trapezoidal velocity profile per block
 *
 * Fills `toolpath.duration` and returns cumulative times per source line.
 */
import type { MachineProfile } from '@/lib/profile/schema';
import { ARC_FIELDS, FLAG, MOTION_FIELDS, SEG, type Toolpath } from './toolpath';

export interface PlannerConfig {
  /** mm/min (A: deg/min) */
  maxRate: [number, number, number, number];
  /** mm/s² (A: deg/s²) */
  accel: [number, number, number, number];
  junctionDeviation: number;
  arcTolerance: number;
  /** Usable planner blocks (GRBL 1.1 on an Uno: 15; grblHAL often 35+) */
  plannerBlocks: number;
}

export function plannerConfig(p: MachineProfile, controllerSettings?: Record<string, string>, plannerBlocks?: number | null): PlannerConfig {
  const c = (id: number, fallback: number) => {
    const v = controllerSettings ? Number(controllerSettings[String(id)]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const m = p.motion;
  return {
    maxRate: [c(110, m.maxRate.x), c(111, m.maxRate.y), c(112, m.maxRate.z), c(113, m.maxRate.a)],
    accel: [c(120, m.acceleration.x), c(121, m.acceleration.y), c(122, m.acceleration.z), c(123, m.acceleration.a)],
    junctionDeviation: c(11, m.junctionDeviation),
    arcTolerance: c(12, m.arcTolerance),
    plannerBlocks: plannerBlocks && plannerBlocks > 1 ? plannerBlocks : p.controller.firmware === 'grblhal' ? 35 : 15,
  };
}

export interface PlanResult {
  totalSeconds: number;
  /** Cumulative seconds at the end of each source line (index = line number) */
  lineEndTime: Float64Array;
  blocks: number;
}

const MIN_JUNCTION_SPEED_SQR = 0;
const LARGE = 1e38;

/** Seconds to cover `len` starting at v0 ending at v1 with cruise vn and accel a (all mm, mm/s, mm/s²). */
export function blockTime(len: number, v0: number, v1: number, vn: number, a: number): number {
  if (len <= 0) return 0;
  const accelDist = Math.max(0, (vn * vn - v0 * v0) / (2 * a));
  const decelDist = Math.max(0, (vn * vn - v1 * v1) / (2 * a));
  if (accelDist + decelDist <= len) {
    return (vn - v0) / a + (vn - v1) / a + (len - accelDist - decelDist) / vn;
  }
  // Triangle: never reaches cruise speed.
  const vp = Math.sqrt(Math.max((2 * a * len + v0 * v0 + v1 * v1) / 2, Math.max(v0, v1) ** 2));
  return Math.max(0, (vp - v0) / a) + Math.max(0, (vp - v1) / a);
}

interface Block {
  len: number;
  nominalSqr: number;
  accel: number;
  maxEntrySqr: number;
  seg: number;
}

/** Smallest of values[i] / |u[i]| over the axes that move. */
function axisLimit(values: number[], u0: number, u1: number, u2: number, u3: number): number {
  let v = LARGE;
  if (Math.abs(u0) > 1e-9) v = Math.min(v, values[0]! / Math.abs(u0));
  if (Math.abs(u1) > 1e-9) v = Math.min(v, values[1]! / Math.abs(u1));
  if (Math.abs(u2) > 1e-9) v = Math.min(v, values[2]! / Math.abs(u2));
  if (Math.abs(u3) > 1e-9) v = Math.min(v, values[3]! / Math.abs(u3));
  return v;
}

/**
 * Hot path (one call per move or arc chord, millions per job): blocks live in
 * a preallocated ring buffer and nothing is allocated per move.
 */
class Planner {
  private ring: Block[];
  private head = 0;
  private size = 0;
  private vEntrySqr = 0;
  private hasPrev = false;
  private pu = [0, 0, 0, 0];
  private prevNominalSqr = 0;
  private time = 0;
  blocks = 0;

  private lastSeg = -1;

  constructor(
    private cfg: PlannerConfig,
    private duration: Float32Array,
    private motion: Float32Array,
  ) {
    this.ring = Array.from({ length: Math.max(1, cfg.plannerBlocks) }, () => ({ len: 0, nominalSqr: 0, accel: 0, maxEntrySqr: 0, seg: 0 }));
  }

  get elapsed() {
    return this.time;
  }

  /** Add a straight move (deltas in mm / deg). `feed` mm/min, or null for a rapid. */
  add(d0: number, d1: number, d2: number, d3: number, feed: number | null, seg: number) {
    const len = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3);
    if (len < 1e-6) return;
    const u0 = d0 / len;
    const u1 = d1 / len;
    const u2 = d2 / len;
    const u3 = d3 / len;
    const accel = axisLimit(this.cfg.accel, u0, u1, u2, u3);
    const rapid = axisLimit(this.cfg.maxRate, u0, u1, u2, u3) / 60;
    const nominal = feed === null ? rapid : Math.min(feed / 60, rapid);
    const nominalSqr = nominal * nominal;

    const pu = this.pu;
    let junctionSqr: number;
    if (!this.hasPrev) {
      junctionSqr = 0;
    } else {
      const cos = -(pu[0]! * u0 + pu[1]! * u1 + pu[2]! * u2 + pu[3]! * u3);
      if (cos > 0.999999) junctionSqr = MIN_JUNCTION_SPEED_SQR;
      else if (cos < -0.999999) junctionSqr = LARGE;
      else {
        const j0 = u0 - pu[0]!;
        const j1 = u1 - pu[1]!;
        const j2 = u2 - pu[2]!;
        const j3 = u3 - pu[3]!;
        const jl = Math.sqrt(j0 * j0 + j1 * j1 + j2 * j2 + j3 * j3);
        const jAccel = jl > 0 ? axisLimit(this.cfg.accel, j0 / jl, j1 / jl, j2 / jl, j3 / jl) : accel;
        const sinHalf = Math.sqrt(0.5 * (1 - cos));
        junctionSqr = Math.max(MIN_JUNCTION_SPEED_SQR, (jAccel * this.cfg.junctionDeviation * sinHalf) / (1 - sinHalf));
      }
    }
    const maxEntrySqr = Math.min(junctionSqr, nominalSqr, this.prevNominalSqr);
    this.hasPrev = true;
    pu[0] = u0;
    pu[1] = u1;
    pu[2] = u2;
    pu[3] = u3;
    this.prevNominalSqr = nominalSqr;
    const b = this.ring[(this.head + this.size) % this.ring.length]!;
    b.len = len;
    b.nominalSqr = nominalSqr;
    b.accel = accel;
    b.maxEntrySqr = maxEntrySqr;
    b.seg = seg;
    this.size++;
    this.blocks++;
    if (this.size >= this.ring.length) this.executeHead();
  }

  /** Execute the head block given what is currently buffered (must stop after the last). */
  private executeHead() {
    const ring = this.ring;
    const cap = ring.length;
    // Backward pass over the buffer: entry speeds that still allow stopping at the end.
    let nextEntrySqr = 0;
    for (let i = this.size - 1; i >= 1; i--) {
      const b = ring[(this.head + i) % cap]!;
      nextEntrySqr = Math.min(b.maxEntrySqr, nextEntrySqr + 2 * b.accel * b.len);
    }
    const head = ring[this.head]!;
    this.head = (this.head + 1) % cap;
    this.size--;
    const v0 = Math.sqrt(this.vEntrySqr);
    const exitSqr = Math.min(this.size ? nextEntrySqr : 0, this.vEntrySqr + 2 * head.accel * head.len, head.nominalSqr);
    const v1 = Math.sqrt(exitSqr);
    const vn = Math.max(Math.sqrt(head.nominalSqr), v0, v1);
    const t = blockTime(head.len, v0, v1, vn, head.accel);
    this.duration[head.seg] = (this.duration[head.seg] ?? 0) + t;
    // Per-segment speed profile for playback (arcs span several blocks).
    const m = head.seg * MOTION_FIELDS;
    if (head.seg !== this.lastSeg) {
      this.lastSeg = head.seg;
      this.motion[m] = v0;
      this.motion[m + 2] = vn;
      this.motion[m + 3] = head.accel;
    } else {
      this.motion[m + 2] = Math.max(this.motion[m + 2]!, vn);
      this.motion[m + 3] = Math.min(this.motion[m + 3]!, head.accel);
    }
    this.motion[m + 1] = v1;
    this.time += t;
    this.vEntrySqr = exitSqr;
  }

  /** Planner empties (machine stops): spindle change, dwell, probe, program end. */
  sync() {
    while (this.size) this.executeHead();
    this.vEntrySqr = 0;
    this.prevNominalSqr = 0;
  }

  addTime(seconds: number, seg: number) {
    this.duration[seg] = (this.duration[seg] ?? 0) + seconds;
    this.time += seconds;
  }
}

/** Plan a toolpath: fills `tp.duration`, returns totals and per-line times. */
export function plan(tp: Toolpath, cfg: PlannerConfig, sourceLines: number): PlanResult {
  tp.duration.fill(0);
  tp.motion.fill(0);
  const planner = new Planner(cfg, tp.duration, tp.motion);
  const prev = [tp.origin[0]!, tp.origin[1]!, tp.origin[2]!, tp.origin[3]!];
  const end = [0, 0, 0, 0];
  const PLANES: [number, number, number][] = [
    [0, 1, 2],
    [2, 0, 1],
    [1, 2, 0],
  ];

  for (let i = 0; i < tp.count; i++) {
    const kind = tp.kind[i]!;
    const flags = tp.flags[i]!;
    for (let k = 0; k < 4; k++) end[k] = tp.end[i * 4 + k]!;
    if (flags & (FLAG.sync | FLAG.pause)) planner.sync();

    if (kind === SEG.dwell) {
      planner.sync();
      planner.addTime(tp.feed[i]!, i);
    } else if (kind === SEG.arcCw || kind === SEG.arcCcw) {
      const a = tp.arcRef[i]! * ARC_FIELDS;
      const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
      const angle = tp.arcs[a + 3]!;
      const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
      const r0 = prev[a0]! - c[a0]!;
      const r1 = prev[a1]! - c[a1]!;
      const radius = Math.hypot(r0, r1);
      const tol = cfg.arcTolerance;
      const segLen = Math.sqrt(Math.max(tol * (2 * radius - tol), 1e-12));
      const segments = Math.max(1, Math.floor(Math.abs(0.5 * angle * radius) / segLen));
      const from = [...prev];
      const p = [...prev];
      const next = [0, 0, 0, 0];
      for (let s = 1; s <= segments; s++) {
        for (let k = 0; k < 4; k++) next[k] = from[k]!;
        if (s === segments) {
          for (let k = 0; k < 4; k++) next[k] = end[k]!;
        } else {
          const th = (angle * s) / segments;
          const cos = Math.cos(th);
          const sin = Math.sin(th);
          next[a0] = c[a0]! + r0 * cos - r1 * sin;
          next[a1] = c[a1]! + r0 * sin + r1 * cos;
          next[lin] = from[lin]! + ((end[lin]! - from[lin]!) * s) / segments;
          next[3] = from[3]! + ((end[3]! - from[3]!) * s) / segments;
        }
        planner.add(next[0]! - p[0]!, next[1]! - p[1]!, next[2]! - p[2]!, next[3]! - p[3]!, tp.feed[i]!, i);
        for (let k = 0; k < 4; k++) p[k] = next[k]!;
      }
    } else {
      planner.add(end[0]! - prev[0]!, end[1]! - prev[1]!, end[2]! - prev[2]!, end[3]! - prev[3]!, kind === SEG.rapid ? null : tp.feed[i]!, i);
      if (kind === SEG.probe) planner.sync();
    }
    for (let k = 0; k < 4; k++) prev[k] = end[k]!;
  }
  planner.sync();

  // Cumulative time per source line.
  const lineEndTime = new Float64Array(sourceLines + 1);
  let acc = 0;
  let li = 0;
  for (let i = 0; i < tp.count; i++) {
    const line = tp.line[i]!;
    while (li < line) lineEndTime[++li] = acc;
    acc += tp.duration[i]!;
    lineEndTime[line] = acc;
  }
  while (li < sourceLines) lineEndTime[++li] = acc;
  return { totalSeconds: planner.elapsed, lineEndTime, blocks: planner.blocks };
}

/**
 * Fraction of a move's length covered after `timeFrac` of its duration,
 * following the trapezoidal speed profile (v0 → vn → v1 at accel a).
 * Falls back to linear when no profile is known.
 */
export function pathFraction(timeFrac: number, len: number, v0: number, v1: number, vn: number, a: number): number {
  const tf = Math.min(1, Math.max(0, timeFrac));
  if (!(len > 0) || !(a > 0) || !(vn > 0)) return tf;
  const T = blockTime(len, v0, v1, vn, a);
  if (!(T > 0)) return tf;
  const t = tf * T;
  const da = Math.max(0, (vn * vn - v0 * v0) / (2 * a));
  const dd = Math.max(0, (vn * vn - v1 * v1) / (2 * a));
  let s: number;
  if (da + dd <= len) {
    const ta = (vn - v0) / a;
    const tc = (len - da - dd) / vn;
    if (t < ta) s = v0 * t + 0.5 * a * t * t;
    else if (t < ta + tc) s = da + vn * (t - ta);
    else {
      const u = t - ta - tc;
      s = len - dd + vn * u - 0.5 * a * u * u;
    }
  } else {
    const vp = Math.sqrt(Math.max((2 * a * len + v0 * v0 + v1 * v1) / 2, Math.max(v0, v1) ** 2));
    const ta = Math.max(0, (vp - v0) / a);
    if (t < ta) s = v0 * t + 0.5 * a * t * t;
    else {
      const u = t - ta;
      s = (vp * vp - v0 * v0) / (2 * a) + vp * u - 0.5 * a * u * u;
    }
  }
  return Math.min(1, Math.max(0, s / len));
}
