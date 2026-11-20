/**
 * Auto-leveling (spec §5): bend a job to follow a probed surface.
 *
 * The height map holds the surface height in *work* coordinates at a grid of
 * points (Z0 was set on the surface before probing, so heights are relative
 * to it). Each move's Z is raised by the bilinearly interpolated height at
 * its X/Y; long moves are split so the correction follows the surface, and
 * G2/G3 arcs (XY plane) become short lines. Everything that is not a motion
 * line is copied unchanged.
 *
 * Refused (returned as errors, nothing written): incremental distance (G91)
 * moves, arcs outside G17, G92 offsets — the result would be wrong.
 */
import { tokenize, type Word } from './interpreter';

export interface HeightMap {
  /** Work X/Y of the first grid point and spacing (mm) */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  /** Surface work Z at each point, row-major (index = j * nx + i), mm */
  z: number[];
}

/** Bilinear height at (x, y) in mm; outside the grid the edge value is used. */
export function heightAt(h: HeightMap, x: number, y: number): number {
  const fx = h.nx > 1 ? Math.min(Math.max((x - h.x0) / h.dx, 0), h.nx - 1) : 0;
  const fy = h.ny > 1 ? Math.min(Math.max((y - h.y0) / h.dy, 0), h.ny - 1) : 0;
  const i = Math.min(Math.floor(fx), Math.max(h.nx - 2, 0));
  const j = Math.min(Math.floor(fy), Math.max(h.ny - 2, 0));
  const tx = h.nx > 1 ? fx - i : 0;
  const ty = h.ny > 1 ? fy - j : 0;
  const at = (a: number, b: number) => h.z[Math.min(b, h.ny - 1) * h.nx + Math.min(a, h.nx - 1)]!;
  const z0 = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
  const z1 = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
  return z0 * (1 - ty) + z1 * ty;
}

export interface LevelResult {
  text: string;
  /** Motion lines rewritten */
  changed: number;
  errors: string[];
  /** Largest correction applied (mm) */
  maxCorrection: number;
}

const fmt = (v: number) => String(Number(v.toFixed(4)));

export function levelGcode(text: string, map: HeightMap, opts: { segment?: number; arcTolerance?: number } = {}): LevelResult {
  const seg = opts.segment ?? Math.max(1, Math.min(map.dx, map.dy) / 2);
  const out: string[] = [];
  const errors: string[] = [];
  let changed = 0;
  let maxCorrection = 0;
  let inches = false;
  let relative = false;
  let plane = 17;
  let motion = 0;
  // current position in mm (work); null = unknown until the first move sets it
  const pos: [number | null, number | null, number | null] = [null, null, null];
  const lines = text.split(/\r?\n/);
  const k = () => (inches ? 25.4 : 1);

  const emit = (code: number, x: number, y: number, z: number, extra: string) => {
    const c = heightAt(map, x, y);
    maxCorrection = Math.max(maxCorrection, Math.abs(c));
    const kk = k();
    out.push(`G${code} X${fmt(x / kk)} Y${fmt(y / kk)} Z${fmt((z + c) / kk)}${extra}`);
  };

  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const { words, error } = tokenize(raw);
    if (error || words.length === 0) {
      out.push(raw);
      return;
    }
    const g = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10));
    for (const v of g) {
      if (v === 200) inches = true;
      else if (v === 210) inches = false;
      else if (v === 900) relative = false;
      else if (v === 910) relative = true;
      else if (v === 170 || v === 180 || v === 190) plane = v / 10;
      else if (v === 0 || v === 10 || v === 20 || v === 30) motion = v / 10;
      else if (v === 920) errors.push(`Line ${n}: G92 offsets can't be leveled.`);
    }
    const nonModalMove = g.some((v) => v === 530 || v === 280 || v === 300 || (v >= 382 && v <= 385) || v === 100);
    const axis = (l: string) => words.find((w) => w.letter === l)?.value;
    const hasAxes = ['X', 'Y', 'Z'].some((l) => axis(l) !== undefined);
    if (!hasAxes || nonModalMove) {
      if (nonModalMove && hasAxes) pos[0] = pos[1] = pos[2] = null; // machine-coordinate / probe move: position unknown
      out.push(raw);
      return;
    }
    if (relative) {
      errors.push(`Line ${n}: incremental (G91) moves can't be leveled.`);
      out.push(raw);
      return;
    }
    const kk = k();
    const target: [number, number, number] = [0, 1, 2].map((i) => {
      const v = axis('XYZ'[i]!);
      return v !== undefined ? v * kk : pos[i] ?? 0;
    }) as [number, number, number];
    const start = pos.map((v, i) => v ?? target[i]!) as [number, number, number];
    // words other than G0-3 / axes / arc words go on their own line first (M, S, T, ...); F stays with the move
    const rest = words.filter((w) => !('XYZIJKR'.includes(w.letter) || (w.letter === 'G' && [0, 10, 20, 30].includes(Math.round(w.value * 10))) || w.letter === 'F' || w.letter === 'N'));
    if (rest.length) out.push(rest.map(wordText).join(' '));
    const f = axis('F');
    const fWord = f !== undefined ? ` F${fmt(f)}` : '';
    if (motion === 2 || motion === 3) {
      if (plane !== 17) {
        errors.push(`Line ${n}: arcs outside the XY plane (G${plane}) can't be leveled.`);
        out.push(raw);
        return;
      }
      const pts = arcPoints(start, target, words, motion === 2, kk, seg, opts.arcTolerance ?? 0.01);
      if (!pts) {
        errors.push(`Line ${n}: invalid arc.`);
        out.push(raw);
        return;
      }
      pts.forEach((p, i) => emit(1, p[0], p[1], p[2], i === 0 ? fWord : ''));
    } else {
      const d = Math.hypot(target[0] - start[0], target[1] - start[1]);
      const pieces = Math.max(1, Math.ceil(d / seg));
      for (let s = 1; s <= pieces; s++) {
        const t = s / pieces;
        emit(motion, start[0] + (target[0] - start[0]) * t, start[1] + (target[1] - start[1]) * t, start[2] + (target[2] - start[2]) * t, s === 1 ? fWord : '');
      }
    }
    changed++;
    pos[0] = target[0];
    pos[1] = target[1];
    pos[2] = target[2];
  });
  return { text: out.join('\n'), changed, errors, maxCorrection };
}

function wordText(w: Word): string {
  return `${w.letter}${fmt(w.value)}`;
}

/** Points along a G17 arc (excluding the start), in mm. */
function arcPoints(start: [number, number, number], end: [number, number, number], words: Word[], cw: boolean, k: number, seg: number, tol: number): [number, number, number][] | null {
  const get = (l: string) => words.find((w) => w.letter === l)?.value;
  let cx: number;
  let cy: number;
  const r = get('R');
  if (r !== undefined) {
    const R = r * k;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-9 || Math.abs(R) < d / 2 - 1e-6) return null;
    const h = Math.sqrt(Math.max(R * R - (d * d) / 4, 0));
    // GRBL: positive R = arc ≤ 180°, negative = > 180°
    const side = (cw ? 1 : -1) * (R > 0 ? 1 : -1);
    cx = start[0] + dx / 2 + (side * h * dy) / d;
    cy = start[1] + dy / 2 - (side * h * dx) / d;
  } else {
    cx = start[0] + (get('I') ?? 0) * k;
    cy = start[1] + (get('J') ?? 0) * k;
  }
  const rad = Math.hypot(start[0] - cx, start[1] - cy);
  const a0 = Math.atan2(start[1] - cy, start[0] - cx);
  const a1 = Math.atan2(end[1] - cy, end[0] - cx);
  let sweep = a1 - a0;
  if (cw && sweep >= -1e-9) sweep -= 2 * Math.PI;
  if (!cw && sweep <= 1e-9) sweep += 2 * Math.PI;
  const chordStep = Math.min(seg, 2 * Math.sqrt(Math.max(tol * (2 * rad - tol), 1e-12)));
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * rad) / Math.max(chordStep, 1e-6)));
  const pts: [number, number, number][] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = a0 + sweep * t;
    pts.push(i === n ? [end[0], end[1], end[2]] : [cx + rad * Math.cos(a), cy + rad * Math.sin(a), start[2] + (end[2] - start[2]) * t]);
  }
  return pts;
}
