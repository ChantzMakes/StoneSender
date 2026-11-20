/**
 * A tiny GRBL-like machine for the browser preview and for unit tests of the
 * probing / tool-change routines. Moves are instantaneous; it understands
 * enough G-code for the app's own commands: G0/G1/G38.x with G90/G91,
 * G20/G21, G53, G10 L2/L20, G54–G59, G4, $J=, $X and the probe pin. Probing
 * runs against solid boxes (stock, touch plate, tool setter).
 *
 * The real emulator (crates/virtual-grbl) is what the desktop app and the
 * Rust integration tests use; this one is deliberately small.
 */
export type V3 = [number, number, number];

export interface SolidBox {
  min: V3;
  max: V3;
}

export interface ProbeOutcome {
  position: V3;
  success: boolean;
}

const AXES = ['X', 'Y', 'Z'] as const;

export class DemoMachine {
  /** Machine position (mm) */
  pos: V3 = [0, 0, 0];
  /** G54..G59 offsets (machine position of work zero, mm) */
  wcs: V3[] = Array.from({ length: 6 }, () => [0, 0, 0] as V3);
  wcsIndex = 0;
  inches = false;
  relative = false;
  alarm: number | null = null;
  /** Solid objects the probe can touch (machine coordinates) */
  solids: SolidBox[] = [];
  /** Forced probe pin (a hand touching the plate to the bit) */
  pinForced = false;
  lastProbe: ProbeOutcome | null = null;
  spindle: 'M3' | 'M4' | 'M5' = 'M5';
  tool = 0;
  /** Every line executed (for tests) */
  log: string[] = [];

  get wco(): V3 {
    return [...this.wcs[this.wcsIndex]!] as V3;
  }

  get workPos(): V3 {
    const o = this.wco;
    return [this.pos[0] - o[0], this.pos[1] - o[1], this.pos[2] - o[2]];
  }

  /** Probe pin: forced, or the tool tip is touching a solid. */
  get probePin(): boolean {
    return this.pinForced || this.solids.some((b) => inside(this.pos, b, 1e-6));
  }

  parserState(): string[] {
    return ['G0', ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'][this.wcsIndex]!, 'G17', this.inches ? 'G20' : 'G21', this.relative ? 'G91' : 'G90', 'G94', this.spindle, 'M9', `T${this.tool}`, 'F0', 'S0'];
  }

  /** Execute one line; returns the reply lines (ending with ok / error:N / ALARM:N). */
  exec(raw: string): string[] {
    const line = raw.toUpperCase().replace(/\s+/g, '');
    this.log.push(line);
    if (line === '$X') {
      this.alarm = null;
      return ['[MSG:Caution: Unlocked]', 'ok'];
    }
    if (line.startsWith('$J=')) {
      if (this.alarm) return ['error:9'];
      return this.jog(line.slice(3));
    }
    if (line === '$G') return [`[GC:${this.parserState().join(' ')}]`, 'ok'];
    if (line.startsWith('$')) return ['ok'];
    if (this.alarm) return ['error:9'];

    const words = [...line.matchAll(/([A-Z])(-?[\d.]+)/g)].map((m) => ({ l: m[1]!, v: Number(m[2]) }));
    const gs = words.filter((w) => w.l === 'G').map((w) => w.v);
    const has = (g: number) => gs.some((v) => Math.abs(v - g) < 1e-6);
    const axis: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
    for (const w of words) if (w.l === 'X' || w.l === 'Y' || w.l === 'Z') axis[w.l] = w.v;
    const unit = (v: number) => (this.inches || has(20) ? v * 25.4 : v);
    for (const w of words) {
      if (w.l === 'M') {
        if (w.v === 6 || w.v === 7) return ['error:20'];
        if (w.v === 3 || w.v === 4 || w.v === 5) this.spindle = `M${w.v}` as 'M3';
      }
      if (w.l === 'T') this.tool = w.v;
    }
    if (has(20)) this.inches = true;
    if (has(21)) this.inches = false;
    if (has(90)) this.relative = false;
    if (has(91)) this.relative = true;
    for (let i = 0; i < 6; i++) if (has(54 + i)) this.wcsIndex = i;

    if (has(10)) {
      const l = words.find((w) => w.l === 'L')?.v;
      const p = words.find((w) => w.l === 'P')?.v ?? 0;
      const idx = p === 0 ? this.wcsIndex : p - 1;
      if (idx < 0 || idx > 5) return ['error:29'];
      const o = this.wcs[idx]!;
      for (const [i, a] of AXES.entries()) {
        const v = axis[a];
        if (v === undefined) continue;
        if (l === 20) o[i] = this.pos[i]! - unit(v);
        else if (l === 2) o[i] = unit(v);
      }
      return ['ok'];
    }
    if (has(4)) return ['ok'];

    const target = [...this.pos] as V3;
    const any = AXES.some((a) => axis[a] !== undefined);
    for (const [i, a] of AXES.entries()) {
      const v = axis[a];
      if (v === undefined) continue;
      if (has(53)) target[i] = unit(v);
      else if (this.relative) target[i] = this.pos[i]! + unit(v);
      else target[i] = unit(v) + this.wco[i]!;
    }
    const probe = gs.find((v) => v > 38 && v < 39);
    if (probe !== undefined) {
      if (!any) return ['error:26'];
      return this.probe(target, Math.round((probe - 38) * 10));
    }
    if (any) this.pos = target;
    return ['ok'];
  }

  private jog(body: string): string[] {
    const rel = body.includes('G91');
    const inches = body.includes('G20');
    const words = [...body.matchAll(/([XYZ])(-?[\d.]+)/g)];
    for (const m of words) {
      const i = AXES.indexOf(m[1] as 'X');
      const v = Number(m[2]) * (inches ? 25.4 : 1);
      this.pos[i] = rel ? this.pos[i]! + v : v + this.wco[i]!;
    }
    return ['ok'];
  }

  /** G38.2 (2) / .3 (3) toward the workpiece; .4 / .5 away (contact lost). */
  private probe(target: V3, kind: number): string[] {
    const toward = kind === 2 || kind === 3;
    const errorOnFail = kind === 2 || kind === 4;
    const start = [...this.pos] as V3;
    if (toward === this.probePin) {
      // GRBL: probe already in the target state → ALARM:4
      this.alarm = 4;
      return ['ALARM:4'];
    }
    let hit: V3 | null = null;
    if (toward) {
      let best = Infinity;
      for (const b of this.solids) {
        const t = entry(start, target, b);
        if (t !== null && t < best) best = t;
      }
      if (best <= 1) hit = lerp(start, target, best);
      if (this.pinForced) hit = start;
    } else {
      // pull-off: contact is lost as soon as we leave the solid
      hit = lerp(start, target, Math.min(1, 0.05 / Math.max(dist(start, target), 1e-9)));
    }
    if (hit) {
      this.pos = hit;
      this.lastProbe = { position: [...hit] as V3, success: true };
      return [`[PRB:${hit.map((v) => v.toFixed(3)).join(',')}:1]`, 'ok'];
    }
    this.lastProbe = { position: [...target] as V3, success: false };
    if (errorOnFail) {
      this.alarm = 5;
      return ['ALARM:5'];
    }
    this.pos = target;
    return [`[PRB:${target.map((v) => v.toFixed(3)).join(',')}:0]`, 'ok'];
  }
}

function inside(p: V3, b: SolidBox, eps = 0): boolean {
  return p.every((v, i) => v >= b.min[i]! - eps && v <= b.max[i]! + eps);
}

function lerp(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dist(a: V3, b: V3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Fraction along a→b where the segment enters box b (slab test), or null. */
function entry(a: V3, bEnd: V3, box: SolidBox): number | null {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = bEnd[i]! - a[i]!;
    if (Math.abs(d) < 1e-12) {
      if (a[i]! < box.min[i]! || a[i]! > box.max[i]!) return null;
      continue;
    }
    let ta = (box.min[i]! - a[i]!) / d;
    let tb = (box.max[i]! - a[i]!) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
