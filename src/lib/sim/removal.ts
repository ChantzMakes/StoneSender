/**
 * Material-removal simulation (spec §6c).
 *
 *  - router: Z heightmap over the stock (a "Z-buffer"): each cell stores the
 *    top of the remaining material. The tool shape (flat, ball, V, engraver,
 *    drill) is stamped along every move at ≤ half a cell spacing.
 *  - laser: burn map: each cell accumulates energy ∝ (S / S_max) × time the
 *    spot spends over it (step / feed speed). Rendered as darkening.
 *  - rotary: cylindrical map (X along the axis × angle): each cell stores the
 *    remaining radius; the tool points down −Z at the rotated stock.
 *
 * Time-driven: `advanceTo(t)` applies everything up to planned time t,
 * including part of the current move (acceleration-aware), so playback
 * animates. `snapshot`/`restore` give keyframes for scrubbing backwards.
 * Also detects problems: rapids that cut (gouges), cuts below the stock,
 * flutes shorter than the material engaged, holder/collet collisions, and
 * small islands of material left inside cut areas.
 */
import { fractionAt, pointOnSegment, segLength, segStartPoint } from '@/lib/gcode/render';
import { SEG, type Toolpath } from '@/lib/gcode/toolpath';
import { resolveTool, toolProfile, type Tool } from './tools';

export type SimMode = 'router' | 'laser' | 'rotary';

export interface Grid {
  /** Router/laser: x0, y0 = min corner of the stock; rotary: x0 = start of stock, y0 = 0 (angle) */
  x0: number;
  y0: number;
  /** Cell size in X (mm) */
  res: number;
  /** Cell size in Y (mm); rotary: radians per cell */
  resY: number;
  nx: number;
  ny: number;
}

export type ProblemKind = 'rapid-gouge' | 'below-stock' | 'holder' | 'flute' | 'island';

export interface SimEvent {
  kind: ProblemKind;
  line: number;
  /** Work coordinates */
  x: number;
  y: number;
  z: number;
  detail: string;
}

export interface RemovalConfig {
  mode: SimMode;
  /** Router/laser stock box (work coordinates) */
  stockMin: [number, number, number];
  stockMax: [number, number, number];
  /** Rotary: stock radius (mm), X extent from stockMin[0] to stockMax[0] */
  rotaryRadius?: number;
  /** Y-substitution rotary: Y mm per revolution (else A axis) */
  ySubstitutionPerRev?: number | null;
  /** Grid cell size (mm); the grid is coarsened to stay under maxCells */
  resolution: number;
  maxCells?: number;
  tools: Tool[];
  jobTools: Record<number, string>;
  defaultToolId: string | null;
  laserMaxPower: number;
  /** Laser spot diameter (mm) */
  laserSpot?: number;
}

export const FLAG_GOUGE = 1;
export const FLAG_BELOW = 2;
export const FLAG_ISLAND = 4;

export interface SimSnapshot {
  data: Float32Array;
  flags: Uint8Array;
  seg: number;
  frac: number;
  time: number;
  events: number;
}

const MAX_EVENTS = 200;

export function chooseGrid(cfg: RemovalConfig): Grid {
  const maxCells = cfg.maxCells ?? 1_000_000;
  if (cfg.mode === 'rotary') {
    const r = Math.max(cfg.rotaryRadius ?? 25, 1);
    const len = Math.max(cfg.stockMax[0] - cfg.stockMin[0], 1);
    const circ = 2 * Math.PI * r;
    let res = Math.max(cfg.resolution, 0.05);
    while ((len / res) * (circ / res) > maxCells) res *= 1.25;
    const nx = Math.max(2, Math.ceil(len / res));
    const ny = Math.max(8, Math.ceil(circ / res));
    return { x0: cfg.stockMin[0], y0: 0, res: len / nx, resY: (2 * Math.PI) / ny, nx, ny };
  }
  const w = Math.max(cfg.stockMax[0] - cfg.stockMin[0], 0.1);
  const d = Math.max(cfg.stockMax[1] - cfg.stockMin[1], 0.1);
  let res = Math.max(cfg.resolution, 0.05);
  while ((w / res) * (d / res) > maxCells) res *= 1.25;
  const nx = Math.max(2, Math.ceil(w / res));
  const ny = Math.max(2, Math.ceil(d / res));
  return { x0: cfg.stockMin[0], y0: cfg.stockMin[1], res: w / nx, resY: d / ny, nx, ny };
}

interface ResolvedTool {
  tool: Tool;
  R: number;
  profile: (d: number) => number;
}

export class RemovalSim {
  readonly grid: Grid;
  readonly mode: SimMode;
  readonly top: number;
  readonly bottom: number;
  data: Float32Array;
  flags: Uint8Array;
  events: SimEvent[] = [];
  private eventKeys = new Set<string>();
  seg = 0;
  frac = 0;
  time = 0;
  /** cells changed since the last takeDirty(): [i0, j0, i1, j1] inclusive, or null */
  dirty: [number, number, number, number] | null = null;
  private toolCache = new Map<number, ResolvedTool>();
  private start = [0, 0, 0, 0];
  private p = [0, 0, 0, 0];
  removedVolume = 0;

  constructor(
    readonly tp: Toolpath,
    readonly segEnd: Float64Array,
    readonly cfg: RemovalConfig,
  ) {
    this.mode = cfg.mode;
    this.grid = chooseGrid(cfg);
    this.top = cfg.stockMax[2];
    this.bottom = cfg.stockMin[2];
    const n = this.grid.nx * this.grid.ny;
    this.data = new Float32Array(n);
    this.flags = new Uint8Array(n);
    this.reset();
  }

  reset() {
    const init = this.mode === 'router' ? this.top : this.mode === 'rotary' ? (this.cfg.rotaryRadius ?? 25) : 0;
    this.data.fill(init);
    this.flags.fill(0);
    this.events = [];
    this.eventKeys.clear();
    this.seg = 0;
    this.frac = 0;
    this.time = 0;
    this.removedVolume = 0;
    this.dirty = [0, 0, this.grid.nx - 1, this.grid.ny - 1];
  }

  snapshot(): SimSnapshot {
    return { data: this.data.slice(), flags: this.flags.slice(), seg: this.seg, frac: this.frac, time: this.time, events: this.events.length };
  }

  restore(s: SimSnapshot) {
    this.data.set(s.data);
    this.flags.set(s.flags);
    this.seg = s.seg;
    this.frac = s.frac;
    this.time = s.time;
    this.events.length = Math.min(this.events.length, s.events);
    this.eventKeys = new Set(this.events.map((e) => `${e.kind}:${e.line}`));
    this.dirty = [0, 0, this.grid.nx - 1, this.grid.ny - 1];
  }

  takeDirty(): [number, number, number, number] | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  private markDirty(i: number, j: number) {
    const d = this.dirty;
    if (!d) this.dirty = [i, j, i, j];
    else {
      if (i < d[0]) d[0] = i;
      if (j < d[1]) d[1] = j;
      if (i > d[2]) d[2] = i;
      if (j > d[3]) d[3] = j;
    }
  }

  private event(kind: ProblemKind, line: number, x: number, y: number, z: number, detail: string) {
    const key = `${kind}:${line}`;
    if (this.eventKeys.has(key) || this.events.length >= MAX_EVENTS) return;
    this.eventKeys.add(key);
    this.events.push({ kind, line, x, y, z, detail });
  }

  private toolFor(seg: number): ResolvedTool {
    const t = this.tp.tool[seg]!;
    const cached = this.toolCache.get(t);
    if (cached) return cached;
    const tool = resolveTool(t, this.cfg.tools, this.cfg.jobTools, this.cfg.defaultToolId)!;
    const resolved = { tool, R: tool.diameter / 2, profile: toolProfile(tool) };
    this.toolCache.set(t, resolved);
    return resolved;
  }

  /** Apply everything up to planned time t. Returns true if anything changed. */
  advanceTo(t: number): boolean {
    const tp = this.tp;
    let changed = false;
    while (this.seg < tp.count) {
      const i = this.seg;
      const segStartTime = this.segEnd[i]! - tp.duration[i]!;
      if (t <= segStartTime && tp.duration[i]! > 0) break;
      const target = t >= this.segEnd[i]! ? 1 : fractionAt(tp, this.segEnd, i, t);
      if (target > this.frac) {
        this.applySegment(i, this.frac, target);
        changed = true;
      }
      if (target >= 1) {
        this.seg++;
        this.frac = 0;
      } else {
        this.frac = target;
        break;
      }
    }
    this.time = t;
    return changed;
  }

  /** Stamp segment i between path fractions fa and fb. */
  private applySegment(i: number, fa: number, fb: number) {
    const tp = this.tp;
    const kind = tp.kind[i]!;
    if (kind === SEG.dwell) return;
    const rapid = kind === SEG.rapid;
    // The first move starts from an assumed position (work zero): a rapid there
    // would "cut" from a place the tool never was (e.g. the rotary axis).
    if (i === 0 && rapid) return;
    const line = tp.line[i]!;
    segStartPoint(tp, i, this.start);
    let len = segLength(tp, i);
    const g = this.grid;
    if (this.mode === 'rotary') {
      // Angular travel counts at the stock surface.
      const e3 = tp.end[i * 4 + 3]!;
      const ang = this.cfg.ySubstitutionPerRev ? 0 : Math.abs(e3 - this.start[3]!) * (Math.PI / 180) * (this.cfg.rotaryRadius ?? 25);
      len = Math.max(len, ang);
    }
    const step = this.mode === 'laser' ? Math.min(g.res, (this.cfg.laserSpot ?? 0.2) / 2) * 0.75 : g.res * 0.5;
    const n = Math.max(1, Math.ceil((len * (fb - fa)) / step));
    if (this.mode === 'laser') {
      if (rapid || tp.spindle[i]! <= 0) return;
      const power = Math.min(1, tp.spindle[i]! / Math.max(this.cfg.laserMaxPower, 1));
      const v = Math.max(tp.feed[i]! / 60, 0.1);
      const dl = (len * (fb - fa)) / n;
      for (let s = 1; s <= n; s++) {
        pointOnSegment(tp, i, fa + ((fb - fa) * s) / n, this.start, this.p);
        this.burn(this.p[0]!, this.p[1]!, (power * dl) / v);
      }
      return;
    }
    const tool = this.toolFor(i);
    // The point at fa was stamped by the previous call (or is the previous move's end).
    for (let s = 1; s <= n; s++) {
      pointOnSegment(tp, i, fa + ((fb - fa) * s) / n, this.start, this.p);
      if (this.mode === 'router') this.stampHeight(this.p[0]!, this.p[1]!, this.p[2]!, tool, rapid, line);
      else this.stampCylinder(this.p, tool, rapid, line);
    }
  }

  private stampHeight(x: number, y: number, z: number, t: ResolvedTool, rapid: boolean, line: number) {
    const g = this.grid;
    const R = t.R;
    if (z >= this.top) {
      // Above the stock: nothing to cut (but the holder check below still skips too).
      return;
    }
    const i0 = Math.max(0, Math.floor((x - R - g.x0) / g.res));
    const i1 = Math.min(g.nx - 1, Math.floor((x + R - g.x0) / g.res));
    const j0 = Math.max(0, Math.floor((y - R - g.y0) / g.resY));
    const j1 = Math.min(g.ny - 1, Math.floor((y + R - g.y0) / g.resY));
    if (i0 > i1 || j0 > j1) return;
    const cellArea = g.res * g.resY;
    let touched = false;
    for (let j = j0; j <= j1; j++) {
      const cy = g.y0 + (j + 0.5) * g.resY - y;
      for (let i = i0; i <= i1; i++) {
        const cx = g.x0 + (i + 0.5) * g.res - x;
        const d2 = cx * cx + cy * cy;
        if (d2 > R * R) continue;
        const k = j * g.nx + i;
        const h = this.data[k]!;
        touched = true;
        const zc = z + t.profile(Math.sqrt(d2));
        if (zc < h) {
          const nh = Math.max(zc, this.bottom);
          this.removedVolume += (h - nh) * cellArea;
          this.data[k] = nh;
          this.markDirty(i, j);
          if (rapid) {
            this.flags[k] = this.flags[k]! | FLAG_GOUGE;
            this.event('rapid-gouge', line, x, y, z, 'Rapid move cuts material');
          }
          if (zc < this.bottom - 0.05) {
            this.flags[k] = this.flags[k]! | FLAG_BELOW;
            this.event('below-stock', line, x, y, z, `Cuts ${(this.bottom - zc).toFixed(2)} mm below the stock`);
          }
        }
      }
    }
    if (rapid || !touched) return;
    // Flutes: the walls right next to the cutter rise higher above the tip than
    // the flutes are long, so the shank rubs.
    const ring = R + Math.max(g.res * 1.5, 0.5);
    let wall = -Infinity;
    const ri0 = Math.max(0, Math.floor((x - ring - g.x0) / g.res));
    const ri1 = Math.min(g.nx - 1, Math.floor((x + ring - g.x0) / g.res));
    const rj0 = Math.max(0, Math.floor((y - ring - g.y0) / g.resY));
    const rj1 = Math.min(g.ny - 1, Math.floor((y + ring - g.y0) / g.resY));
    for (let j = rj0; j <= rj1; j++) {
      const cy = g.y0 + (j + 0.5) * g.resY - y;
      for (let i = ri0; i <= ri1; i++) {
        const cx = g.x0 + (i + 0.5) * g.res - x;
        const d2 = cx * cx + cy * cy;
        if (d2 <= R * R || d2 > ring * ring) continue;
        const h = this.data[j * g.nx + i]!;
        if (h > wall) wall = h;
      }
    }
    if (wall - z > t.tool.fluteLength + 0.05) {
      this.event('flute', line, x, y, z, `The cut is ${(wall - z).toFixed(1)} mm deep next to the bit but its flutes are only ${t.tool.fluteLength} mm long`);
    }
    // Holder / collet: anything within the holder radius above (tip + stickout).
    const holderZ = z + t.tool.stickout;
    if (holderZ < this.top) {
      const HR = t.tool.holderDiameter / 2;
      const hi0 = Math.max(0, Math.floor((x - HR - g.x0) / g.res));
      const hi1 = Math.min(g.nx - 1, Math.floor((x + HR - g.x0) / g.res));
      const hj0 = Math.max(0, Math.floor((y - HR - g.y0) / g.resY));
      const hj1 = Math.min(g.ny - 1, Math.floor((y + HR - g.y0) / g.resY));
      for (let j = hj0; j <= hj1; j++) {
        const cy = g.y0 + (j + 0.5) * g.resY - y;
        for (let i = hi0; i <= hi1; i++) {
          const cx = g.x0 + (i + 0.5) * g.res - x;
          if (cx * cx + cy * cy > HR * HR) continue;
          if (this.data[j * g.nx + i]! > holderZ + 0.05) {
            this.event('holder', line, x, y, z, `The holder / collet (Ø${t.tool.holderDiameter} mm, ${t.tool.stickout} mm above the tip) would hit the stock`);
            return;
          }
        }
      }
    }
  }

  private burn(x: number, y: number, energy: number) {
    const g = this.grid;
    const r = Math.max((this.cfg.laserSpot ?? 0.2) / 2, g.res * 0.5);
    const i0 = Math.max(0, Math.floor((x - r - g.x0) / g.res));
    const i1 = Math.min(g.nx - 1, Math.floor((x + r - g.x0) / g.res));
    const j0 = Math.max(0, Math.floor((y - r - g.y0) / g.resY));
    const j1 = Math.min(g.ny - 1, Math.floor((y + r - g.y0) / g.resY));
    // Energy per unit length spread over the spot's width.
    const w = energy / (2 * r);
    for (let j = j0; j <= j1; j++) {
      const cy = g.y0 + (j + 0.5) * g.resY - y;
      for (let i = i0; i <= i1; i++) {
        const cx = g.x0 + (i + 0.5) * g.res - x;
        if (cx * cx + cy * cy > r * r) continue;
        { const k = j * g.nx + i; this.data[k] = this.data[k]! + w; }
        this.markDirty(i, j);
      }
    }
  }

  private stampCylinder(p: number[], t: ResolvedTool, rapid: boolean, line: number) {
    const g = this.grid;
    const R = t.R;
    const x = p[0]!;
    const z = p[2]!;
    const deg = this.cfg.ySubstitutionPerRev ? (p[1]! / this.cfg.ySubstitutionPerRev) * 360 : p[3]!;
    const r0 = this.cfg.rotaryRadius ?? 25;
    if (z >= r0) return;
    // The stock is rotated by +A; in the stock's own frame the tool sits at angle −A.
    const theta0 = (-deg * Math.PI) / 180;
    const i0 = Math.max(0, Math.floor((x - R - g.x0) / g.res));
    const i1 = Math.min(g.nx - 1, Math.floor((x + R - g.x0) / g.res));
    if (i0 > i1) return;
    const halfAng = Math.min(Math.PI / 2, Math.asin(Math.min(1, R / Math.max(z, R, 0.5))) + g.resY);
    const dj = Math.ceil(halfAng / g.resY);
    const jc = Math.round(theta0 / g.resY);
    const cellArea = g.res * g.resY;
    for (let jj = jc - dj; jj <= jc + dj; jj++) {
      const j = ((jj % g.ny) + g.ny) % g.ny;
      let phi = (j + 0.5) * g.resY - theta0;
      phi = Math.atan2(Math.sin(phi), Math.cos(phi));
      const cos = Math.cos(phi);
      if (cos <= 0) continue;
      for (let i = i0; i <= i1; i++) {
        const k = j * g.nx + i;
        const r = this.data[k]!;
        const yy = r * Math.sin(phi);
        const dx = g.x0 + (i + 0.5) * g.res - x;
        const d = Math.hypot(dx, yy);
        if (d > R) continue;
        const rmax = Math.max(0, (z + t.profile(d)) / cos);
        if (rmax < r) {
          // annular sector: ½(r² − r'²)·dθ·dx
          this.removedVolume += 0.5 * (r * r - rmax * rmax) * cellArea;
          this.data[k] = rmax;
          this.markDirty(i, j);
          if (rapid) {
            this.flags[k] = this.flags[k]! | FLAG_GOUGE;
            this.event('rapid-gouge', line, x, p[1]!, z, 'Rapid move cuts material');
          }
        }
      }
    }
  }

  /**
   * Small islands of untouched material inside cut areas — often slivers a
   * pocket's stepover missed. Router only; call after the run.
   */
  findIslands(maxAreaMm2: number, tol = 0.1): { count: number; centers: [number, number][] } {
    if (this.mode !== 'router') return { count: 0, centers: [] };
    const g = this.grid;
    const n = g.nx * g.ny;
    const uncut = (k: number) => this.data[k]! >= this.top - tol;
    const seen = new Uint8Array(n);
    const centers: [number, number][] = [];
    let count = 0;
    const cellArea = g.res * g.resY;
    const maxCells = Math.max(1, Math.floor(maxAreaMm2 / cellArea));
    const stack: number[] = [];
    for (let k0 = 0; k0 < n; k0++) {
      if (seen[k0] || !uncut(k0)) continue;
      stack.length = 0;
      stack.push(k0);
      seen[k0] = 1;
      const cells: number[] = [];
      let touchesBorder = false;
      while (stack.length) {
        const k = stack.pop()!;
        cells.push(k);
        const i = k % g.nx;
        const j = (k - i) / g.nx;
        if (i === 0 || j === 0 || i === g.nx - 1 || j === g.ny - 1) touchesBorder = true;
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.ny) continue;
          const nk = nj * g.nx + ni;
          if (!seen[nk] && uncut(nk)) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
        if (cells.length > maxCells) break;
      }
      // Drain the rest of a large component so it isn't revisited cell by cell.
      while (stack.length) {
        const k = stack.pop()!;
        const i = k % g.nx;
        const j = (k - i) / g.nx;
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.ny) continue;
          const nk = nj * g.nx + ni;
          if (!seen[nk] && uncut(nk)) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
      if (touchesBorder || cells.length > maxCells) continue;
      count++;
      let sx = 0;
      let sy = 0;
      for (const k of cells) {
        this.flags[k] = this.flags[k]! | FLAG_ISLAND;
        const i = k % g.nx;
        sx += g.x0 + (i + 0.5) * g.res;
        sy += g.y0 + ((k - i) / g.nx + 0.5) * g.resY;
      }
      const c: [number, number] = [sx / cells.length, sy / cells.length];
      if (centers.length < 50) centers.push(c);
    }
    if (count) this.dirty = [0, 0, g.nx - 1, g.ny - 1];
    return { count, centers };
  }

  /** Deepest point cut (router): lowest material top. */
  minHeight(): number {
    let m = Infinity;
    for (const v of this.data) if (v < m) m = v;
    return m;
  }
}
