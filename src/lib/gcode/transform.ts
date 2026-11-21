/**
 * G-code transforms (spec §5): translate, rotate, mirror, scale, arcs → lines
 * and feed scaling, applied to the job text.
 *
 * Every line that isn't a move is copied unchanged (comments too). Moves get
 * their axis words rewritten; arcs stay arcs where the transform allows it
 * (I/J/K are vectors, mirroring swaps G2/G3) and become short lines where it
 * doesn't (non-uniform scale). Incremental (G91) moves get the linear part of
 * the transform only. Amounts are in mm (converted for G20 files).
 *
 * The result goes back through the normal pipeline (analysis, 3D view,
 * pre-flight) as a new file — nothing is sent from here.
 */
import { tokenize, type Word } from './interpreter';

export type Transform =
  | { kind: 'translate'; dx: number; dy: number; dz: number }
  | { kind: 'rotate'; angleDeg: number; cx: number; cy: number }
  | { kind: 'mirror'; axis: 'x' | 'y'; about: number }
  | { kind: 'scale'; sx: number; sy: number; sz: number; cx: number; cy: number }
  | { kind: 'arcs-to-lines'; tolerance: number }
  | { kind: 'feed'; factor: number };

export interface TransformResult {
  text: string;
  changed: number;
  errors: string[];
  warnings: string[];
}

const fmt = (v: number) => String(Number(v.toFixed(4)));
type V3 = [number, number, number];

/** Linear part (matrix on XY, factor on Z) + translation, in mm. */
interface Affine {
  m: [number, number, number, number]; // [a b; c d] on (x, y)
  sz: number;
  t: V3;
  /** Does this transform reverse orientation (mirror)? */
  flips: boolean;
  /** Arcs can stay arcs (similarity transform) */
  keepsArcs: boolean;
  /** Radius factor for R words / similarity scale */
  r: number;
}

function affineOf(t: Transform): Affine | null {
  switch (t.kind) {
    case 'translate':
      return { m: [1, 0, 0, 1], sz: 1, t: [t.dx, t.dy, t.dz], flips: false, keepsArcs: true, r: 1 };
    case 'rotate': {
      const a = (t.angleDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // p' = R (p − c) + c
      return { m: [c, -s, s, c], sz: 1, t: [t.cx - (c * t.cx - s * t.cy), t.cy - (s * t.cx + c * t.cy), 0], flips: false, keepsArcs: true, r: 1 };
    }
    case 'mirror':
      return t.axis === 'x'
        ? { m: [-1, 0, 0, 1], sz: 1, t: [2 * t.about, 0, 0], flips: true, keepsArcs: true, r: 1 }
        : { m: [1, 0, 0, -1], sz: 1, t: [0, 2 * t.about, 0], flips: true, keepsArcs: true, r: 1 };
    case 'scale': {
      const uniform = Math.abs(Math.abs(t.sx) - Math.abs(t.sy)) < 1e-12;
      return { m: [t.sx, 0, 0, t.sy], sz: t.sz, t: [t.cx - t.sx * t.cx, t.cy - t.sy * t.cy, 0], flips: t.sx * t.sy < 0, keepsArcs: uniform, r: Math.abs(t.sx) };
    }
    default:
      return null;
  }
}

const apply = (A: Affine, p: V3, translate = true): V3 => [
  A.m[0] * p[0] + A.m[1] * p[1] + (translate ? A.t[0] : 0),
  A.m[2] * p[0] + A.m[3] * p[1] + (translate ? A.t[1] : 0),
  A.sz * p[2] + (translate ? A.t[2] : 0),
];

/** Text of the comments on a line, to keep them on rewritten lines. */
function comments(raw: string): string {
  const parts = raw.match(/\([^)]*\)|;.*$/g);
  return parts ? ` ${parts.join(' ')}` : '';
}

export function transformGcode(text: string, tr: Transform): TransformResult {
  const A = affineOf(tr);
  const out: string[] = [];
  const errors: string[] = [];
  const warnings = new Set<string>();
  let changed = 0;
  let inches = false;
  let relative = false;
  let plane = 17;
  let motion = 0;
  const pos: V3 = [0, 0, 0]; // original program position, mm
  const k = () => (inches ? 25.4 : 1);

  text.split(/\r?\n/).forEach((raw, idx) => {
    const n = idx + 1;
    const { words, error } = tokenize(raw);
    if (error || words.length === 0) {
      out.push(raw);
      return;
    }
    const gs = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10));
    for (const g of gs) {
      if (g === 200) inches = true;
      else if (g === 210) inches = false;
      else if (g === 900) relative = false;
      else if (g === 910) relative = true;
      else if (g === 170 || g === 180 || g === 190) plane = g / 10;
      else if (g === 0 || g === 10 || g === 20 || g === 30) motion = g / 10;
      else if ((g === 920 || g === 100) && A) warnings.add(`Line ${n} sets offsets (G${g / 10}); they are not transformed.`);
    }

    // --- feed scaling: only F words change
    if (tr.kind === 'feed') {
      if (!words.some((w) => w.letter === 'F')) return void out.push(raw);
      changed++;
      out.push(rebuild(words.map((w) => (w.letter === 'F' ? { ...w, value: w.value * tr.factor } : w)), raw));
      return;
    }

    const special = gs.some((g) => g === 530 || g === 280 || g === 300 || g === 281 || g === 301 || g === 100 || g === 920 || (g >= 382 && g <= 385));
    const get = (l: string) => words.find((w) => w.letter === l)?.value;
    const hasXYZ = ['X', 'Y', 'Z'].some((l) => get(l) !== undefined);
    if (!hasXYZ || special) {
      if (special && hasXYZ && gs.includes(530) && A) warnings.add(`Line ${n} moves in machine coordinates (G53); it is left as it is.`);
      out.push(raw);
      return;
    }
    const kk = k();
    const arc = motion === 2 || motion === 3;

    // target in original coordinates (mm)
    const target: V3 = [0, 1, 2].map((i) => {
      const v = get('XYZ'[i]!);
      if (v === undefined) return relative ? 0 : pos[i]!;
      return v * kk;
    }) as V3;
    const start: V3 = [...pos];
    const absTarget: V3 = relative ? [pos[0] + target[0], pos[1] + target[1], pos[2] + target[2]] : target;

    if (tr.kind === 'arcs-to-lines' || (A && arc && !A.keepsArcs)) {
      if (!arc) {
        out.push(raw);
      } else if (plane !== 17) {
        errors.push(`Line ${n}: arcs outside the XY plane (G${plane}) can't be converted.`);
        out.push(raw);
      } else {
        const pts = arcPoints(start, absTarget, words, motion === 2, kk, tr.kind === 'arcs-to-lines' ? tr.tolerance : 0.01);
        if (!pts) {
          errors.push(`Line ${n}: invalid arc.`);
          out.push(raw);
        } else {
          const rest = words.filter((w) => !'XYZIJKR'.includes(w.letter) && !(w.letter === 'G' && [20, 30].includes(Math.round(w.value * 10))));
          const lines = pts.map((p, i) => {
            const q = A ? apply(A, p) : p;
            const prefix = i === 0 ? rest.filter((w) => w.letter !== 'G' || ![0, 10].includes(Math.round(w.value * 10))).map(wordText).join(' ') : '';
            return `${prefix ? prefix + ' ' : ''}G90 G1 X${fmt(q[0] / kk)} Y${fmt(q[1] / kk)} Z${fmt(q[2] / kk)}`;
          });
          if (relative) lines.push('G91');
          out.push(...lines);
          motion = 1;
          changed++;
          out[out.length - 1] += comments(raw);
        }
      }
      pos[0] = absTarget[0];
      pos[1] = absTarget[1];
      pos[2] = absTarget[2];
      return;
    }
    if (!A) {
      out.push(raw);
      return;
    }
    if (arc && plane !== 17 && (tr.kind === 'rotate' || tr.kind === 'mirror' || tr.kind === 'scale')) {
      errors.push(`Line ${n}: arcs outside the XY plane (G${plane}) can't be ${tr.kind === 'rotate' ? 'rotated' : tr.kind === 'mirror' ? 'mirrored' : 'scaled'}.`);
      out.push(raw);
      return;
    }

    const newTarget = relative ? apply(A, target, false) : apply(A, target);
    const hasXY = get('X') !== undefined || get('Y') !== undefined;
    const mixes = A.m[1] !== 0 || A.m[2] !== 0; // rotation: X and Y each depend on both
    const outWords: Word[] = [];
    for (const w of words) {
      if (w.letter === 'X' || w.letter === 'Y') continue;
      if (w.letter === 'Z') {
        outWords.push({ letter: 'Z', value: newTarget[2] / kk });
        continue;
      }
      if (arc && (w.letter === 'I' || w.letter === 'J')) continue;
      if (arc && w.letter === 'R') {
        outWords.push({ letter: 'R', value: w.value * A.r });
        continue;
      }
      if (w.letter === 'G' && arc && A.flips && [20, 30].includes(Math.round(w.value * 10))) {
        outWords.push({ letter: 'G', value: Math.round(w.value * 10) === 20 ? 3 : 2 });
        continue;
      }
      outWords.push(w);
    }
    if (hasXY) {
      if (get('X') !== undefined || mixes) outWords.push({ letter: 'X', value: newTarget[0] / kk });
      if (get('Y') !== undefined || mixes) outWords.push({ letter: 'Y', value: newTarget[1] / kk });
    }
    if (arc) {
      const ij = apply(A, [(get('I') ?? 0) * kk, (get('J') ?? 0) * kk, 0], false);
      if (get('R') === undefined) {
        outWords.push({ letter: 'I', value: ij[0] / kk });
        outWords.push({ letter: 'J', value: ij[1] / kk });
      }
      // A mirrored arc written with the modal G2/G3 (no G word on the line) needs the flipped word.
      if (A.flips && !words.some((w) => w.letter === 'G' && [20, 30].includes(Math.round(w.value * 10)))) {
        outWords.unshift({ letter: 'G', value: motion === 2 ? 3 : 2 });
        motion = motion === 2 ? 3 : 2;
        warnings.add('Mirrored arcs that relied on the modal G2/G3 now carry their own G word.');
      }
    }
    out.push(rebuild(outWords, raw));
    changed++;
    pos[0] = absTarget[0];
    pos[1] = absTarget[1];
    pos[2] = absTarget[2];
  });
  return { text: out.join('\n'), changed, errors, warnings: [...warnings] };
}

function wordText(w: Word): string {
  return `${w.letter}${fmt(w.value)}`;
}

function rebuild(words: Word[], raw: string): string {
  return words.map(wordText).join(' ') + comments(raw);
}

/** Points along a G17 arc after `start` (mm). */
function arcPoints(start: V3, end: V3, words: Word[], cw: boolean, k: number, tol: number): V3[] | null {
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
  const t = Math.max(tol, 1e-4);
  const step = 2 * Math.sqrt(Math.max(t * (2 * rad - t), 1e-12));
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * rad) / step));
  const pts: V3[] = [];
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const a = a0 + sweep * f;
    pts.push(i === n ? [...end] : [cx + rad * Math.cos(a), cy + rad * Math.sin(a), start[2] + (end[2] - start[2]) * f]);
  }
  return pts;
}
