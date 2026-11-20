/**
 * Compact, columnar toolpath storage. Millions of segments must fit in memory
 * and cross the worker boundary without copying, so everything lives in typed
 * arrays (transferable) instead of objects.
 *
 * Segment i runs from the end of segment i−1 (or `origin` for i = 0) to
 * `end[i]`. Coordinates are **machine coordinates** (mm; A in degrees),
 * computed with the work offsets the interpreter was given.
 */

export const SEG = {
  rapid: 0,
  feed: 1,
  arcCw: 2,
  arcCcw: 3,
  probe: 4,
  dwell: 5,
} as const;
export type SegKind = (typeof SEG)[keyof typeof SEG];

/** Per-segment flags */
export const FLAG = {
  /** Controller empties its planner before this segment (spindle/coolant change, dwell, probe, M0…) */
  sync: 1,
  /** Spindle / laser is on during this segment */
  powerOn: 2,
  /** Feed came from inverse-time mode (G93) */
  inverseTime: 4,
  /** Move was in machine coordinates (G53) */
  machine: 8,
  /** Program pause (M0/M1) happens before this segment */
  pause: 16,
} as const;

export interface Toolpath {
  count: number;
  origin: Float32Array; // 4
  kind: Uint8Array;
  flags: Uint8Array;
  line: Uint32Array;
  /** end x,y,z,a per segment */
  end: Float32Array;
  /** mm/min for motion; seconds for dwell segments */
  feed: Float32Array;
  /** S value in effect (0 when spindle/laser is off) */
  spindle: Float32Array;
  tool: Uint16Array;
  /** index into `arcs` (−1 for non-arcs) */
  arcRef: Int32Array;
  /** per arc: cx, cy, cz (machine), angular travel (rad, signed), plane (0 XY, 1 ZX, 2 YZ) */
  arcs: Float32Array;
  arcCount: number;
  /** seconds, filled by the planner */
  duration: Float32Array;
}

const ARC_STRIDE = 5;
export const ARC_FIELDS = ARC_STRIDE;

/** Growable builder; `finish()` trims to size. */
export class ToolpathBuilder {
  private cap: number;
  private arcCap: number;
  count = 0;
  arcCount = 0;
  origin = new Float32Array(4);
  kind: Uint8Array;
  flags: Uint8Array;
  line: Uint32Array;
  end: Float32Array;
  feed: Float32Array;
  spindle: Float32Array;
  tool: Uint16Array;
  arcRef: Int32Array;
  arcs: Float32Array;

  constructor(initial = 4096) {
    this.cap = initial;
    this.arcCap = 256;
    this.kind = new Uint8Array(initial);
    this.flags = new Uint8Array(initial);
    this.line = new Uint32Array(initial);
    this.end = new Float32Array(initial * 4);
    this.feed = new Float32Array(initial);
    this.spindle = new Float32Array(initial);
    this.tool = new Uint16Array(initial);
    this.arcRef = new Int32Array(initial);
    this.arcs = new Float32Array(this.arcCap * ARC_STRIDE);
  }

  private grow() {
    const cap = this.cap * 2;
    const g = <T extends Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array>(a: T, mul = 1): T => {
      const n = new (a.constructor as new (len: number) => T)(cap * mul);
      n.set(a);
      return n;
    };
    this.kind = g(this.kind);
    this.flags = g(this.flags);
    this.line = g(this.line);
    this.end = g(this.end, 4);
    this.feed = g(this.feed);
    this.spindle = g(this.spindle);
    this.tool = g(this.tool);
    this.arcRef = g(this.arcRef);
    this.cap = cap;
  }

  push(kind: SegKind, flags: number, line: number, end: ArrayLike<number>, feed: number, spindle: number, tool: number, arc?: { cx: number; cy: number; cz: number; angle: number; plane: number }) {
    if (this.count >= this.cap) this.grow();
    const i = this.count++;
    this.kind[i] = kind;
    this.flags[i] = flags;
    this.line[i] = line;
    this.end[i * 4] = end[0]!;
    this.end[i * 4 + 1] = end[1]!;
    this.end[i * 4 + 2] = end[2]!;
    this.end[i * 4 + 3] = end[3]!;
    this.feed[i] = feed;
    this.spindle[i] = spindle;
    this.tool[i] = tool;
    if (arc) {
      if (this.arcCount >= this.arcCap) {
        this.arcCap *= 2;
        const n = new Float32Array(this.arcCap * ARC_STRIDE);
        n.set(this.arcs);
        this.arcs = n;
      }
      const a = this.arcCount++;
      this.arcs.set([arc.cx, arc.cy, arc.cz, arc.angle, arc.plane], a * ARC_STRIDE);
      this.arcRef[i] = a;
    } else {
      this.arcRef[i] = -1;
    }
  }

  /** Drop segments added after a checkpoint (used when a line is rejected). */
  truncate(count: number, arcCount: number) {
    this.count = Math.min(this.count, count);
    this.arcCount = Math.min(this.arcCount, arcCount);
  }

  finish(): Toolpath {
    const n = this.count;
    return {
      count: n,
      origin: this.origin,
      kind: this.kind.slice(0, n),
      flags: this.flags.slice(0, n),
      line: this.line.slice(0, n),
      end: this.end.slice(0, n * 4),
      feed: this.feed.slice(0, n),
      spindle: this.spindle.slice(0, n),
      tool: this.tool.slice(0, n),
      arcRef: this.arcRef.slice(0, n),
      arcs: this.arcs.slice(0, this.arcCount * ARC_STRIDE),
      arcCount: this.arcCount,
      duration: new Float32Array(n),
    };
  }
}

/** Start point of segment i (end of the previous one). */
export function segStart(tp: Toolpath, i: number, out: Float64Array | number[] = new Float64Array(4)): Float64Array | number[] {
  const src = i === 0 ? tp.origin : tp.end;
  const o = i === 0 ? 0 : (i - 1) * 4;
  out[0] = src[o]!;
  out[1] = src[o + 1]!;
  out[2] = src[o + 2]!;
  out[3] = src[o + 3]!;
  return out;
}

/** Buffers to pass as the transfer list of postMessage. */
export function transferables(tp: Toolpath): ArrayBuffer[] {
  return [tp.origin, tp.kind, tp.flags, tp.line, tp.end, tp.feed, tp.spindle, tp.tool, tp.arcRef, tp.arcs, tp.duration].map((a) => a.buffer as ArrayBuffer);
}
