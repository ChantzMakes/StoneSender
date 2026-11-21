/**
 * Collision and limit checks over a toolpath (spec §6b):
 *  - moves outside the machine travel (per axis/side, first line, amount)
 *  - cutting below the bottom of the stock (into the spoilboard / bed)
 *  - rapid moves that pass through the stock
 *
 * All inputs are in work coordinates except `bounds` (machine) and `wco`
 * (machine position of work zero).
 */
import { ARC_FIELDS, SEG, type Toolpath } from '@/lib/gcode/toolpath';
import type { Box3, Vec3 } from './setup';

export interface TravelOver {
  axis: 'X' | 'Y' | 'Z';
  side: 'min' | 'max';
  amount: number;
  line: number;
}

export interface Problem {
  kind: 'travel' | 'below-stock' | 'rapid-through-stock';
  line: number;
  /** Work coordinates */
  point: Vec3;
}

export interface CheckResult {
  travel: TravelOver[];
  belowStock: { maxDepth: number; line: number; count: number } | null;
  rapidsThroughStock: { line: number; point: Vec3 }[];
  rapidsThroughStockCount: number;
  /** Sample points for markers in the 3D view (capped) */
  problems: Problem[];
}

export interface CheckInput {
  tp: Toolpath;
  wco: Vec3;
  /** Machine travel, machine coordinates */
  bounds: { min: Vec3; max: Vec3 };
  stock: Box3 | null;
  toolRadius: number;
  laser: boolean;
}

const PLANES: [number, number, number][] = [
  [0, 1, 2],
  [2, 0, 1],
  [1, 2, 0],
];
const MAX_PROBLEMS = 200;
const TOL = 0.05;

/** Does the segment p→q pass through the (open) box? Slab method. */
export function segmentHitsBox(p: Vec3, q: Vec3, box: Box3): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = q[k]! - p[k]!;
    if (Math.abs(d) < 1e-12) {
      if (p[k]! <= box.min[k]! || p[k]! >= box.max[k]!) return false;
    } else {
      let a = (box.min[k]! - p[k]!) / d;
      let b = (box.max[k]! - p[k]!) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 >= t1) return false;
    }
  }
  return t1 - t0 > 1e-9;
}

export function runChecks(input: CheckInput): CheckResult {
  const { tp, wco, bounds, stock, toolRadius, laser } = input;
  const res: CheckResult = { travel: [], belowStock: null, rapidsThroughStock: [], rapidsThroughStockCount: 0, problems: [] };
  const axes = ['X', 'Y', 'Z'] as const;
  const worst: (TravelOver | undefined)[] = [];
  const addProblem = (p: Problem) => {
    if (res.problems.length < MAX_PROBLEMS) res.problems.push(p);
  };
  const rapidBox: Box3 | null = stock
    ? { min: [stock.min[0] - toolRadius, stock.min[1] - toolRadius, stock.min[2]], max: [stock.max[0] + toolRadius, stock.max[1] + toolRadius, stock.max[2] - TOL] }
    : null;

  const over = (k: number, side: 'min' | 'max', amount: number, p: number[], line: number) => {
    const key = k * 2 + (side === 'max' ? 1 : 0);
    const cur = worst[key];
    if (!cur) {
      worst[key] = { axis: axes[k]!, side, amount, line };
      addProblem({ kind: 'travel', line, point: [p[0]!, p[1]!, p[2]!] });
    } else if (amount > cur.amount) cur.amount = amount;
  };
  // Hot path (every move and arc step of multi-million-line jobs): no allocations
  // unless a problem is found.
  const checkPoint = (p: number[], line: number, cutting: boolean) => {
    for (let k = 0; k < 3; k++) {
      const m = p[k]! + wco[k]!;
      const lo = bounds.min[k]! - m;
      const hi = m - bounds.max[k]!;
      if (lo > 0.01) over(k, 'min', lo, p, line);
      if (hi > 0.01) over(k, 'max', hi, p, line);
    }
    if (cutting && stock && !laser && p[2]! < stock.min[2] - TOL) {
      const depth = stock.min[2] - p[2]!;
      if (!res.belowStock) {
        res.belowStock = { maxDepth: depth, line, count: 0 };
        addProblem({ kind: 'below-stock', line, point: [p[0]!, p[1]!, p[2]!] });
      }
      res.belowStock.maxDepth = Math.max(res.belowStock.maxDepth, depth);
      res.belowStock.count++;
    }
  };

  const prev = [tp.origin[0]!, tp.origin[1]!, tp.origin[2]!];
  const end = [0, 0, 0];
  const arcPoint = [0, 0, 0];
  for (let i = 0; i < tp.count; i++) {
    const kind = tp.kind[i]!;
    for (let k = 0; k < 3; k++) end[k] = tp.end[i * 4 + k]!;
    if (kind === SEG.dwell) continue;
    const line = tp.line[i]!;
    const cutting = kind !== SEG.rapid;
    if (kind === SEG.arcCw || kind === SEG.arcCcw) {
      const a = tp.arcRef[i]! * ARC_FIELDS;
      const c = [tp.arcs[a]!, tp.arcs[a + 1]!, tp.arcs[a + 2]!];
      const angle = tp.arcs[a + 3]!;
      const [a0, a1, lin] = PLANES[tp.arcs[a + 4]!]!;
      const r0 = prev[a0]! - c[a0]!;
      const r1 = prev[a1]! - c[a1]!;
      const steps = Math.max(2, Math.ceil(Math.abs(angle) / (Math.PI / 18)));
      const p = arcPoint;
      for (let s = 1; s <= steps; s++) {
        const th = (angle * s) / steps;
        p[0] = prev[0]!;
        p[1] = prev[1]!;
        p[2] = prev[2]!;
        p[a0] = c[a0]! + r0 * Math.cos(th) - r1 * Math.sin(th);
        p[a1] = c[a1]! + r0 * Math.sin(th) + r1 * Math.cos(th);
        p[lin] = prev[lin]! + ((end[lin]! - prev[lin]!) * s) / steps;
        checkPoint(p, line, true);
      }
    } else {
      checkPoint(end, line, cutting);
      // A straight-up retract leaves through the slot it just cut; without a material
      // simulation (Phase 6) we can't tell cut from uncut, so retracts are exempt.
      const retract = end[2]! > prev[2]! && Math.hypot(end[0]! - prev[0]!, end[1]! - prev[1]!) < Math.max(toolRadius, 0.01);
      if (!cutting && !retract && rapidBox && !laser && segmentHitsBox(prev as Vec3, end as Vec3, rapidBox)) {
        res.rapidsThroughStockCount++;
        if (res.rapidsThroughStock.length < 20) {
          const mid: Vec3 = [(prev[0]! + end[0]!) / 2, (prev[1]! + end[1]!) / 2, (prev[2]! + end[2]!) / 2];
          res.rapidsThroughStock.push({ line, point: mid });
          addProblem({ kind: 'rapid-through-stock', line, point: mid });
        }
      }
    }
    for (let k = 0; k < 3; k++) prev[k] = end[k]!;
  }
  res.travel = worst.filter((w): w is TravelOver => !!w).sort((a, b) => a.line - b.line);
  return res;
}
