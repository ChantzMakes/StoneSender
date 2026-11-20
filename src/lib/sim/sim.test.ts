import { describe, expect, it } from 'vitest';
import { interpret } from '@/lib/gcode/interpreter';
import { machineBounds } from '@/lib/profile/geometry';
import { profileFromPreset } from '@/lib/profile/presets';
import { runChecks, segmentHitsBox } from './checks';
import { assumedWco, bedZ, defaultStock, stockBox, type Box3, type Vec3 } from './setup';

const router = profileFromPreset('generic-router'); // 400 × 400 × 80, negative space
const env = machineBounds(router);
const bounds = { min: [env.min.x, env.min.y, env.min.z] as Vec3, max: [env.max.x, env.max.y, env.max.z] as Vec3 };
const stock: Box3 = { min: [0, 0, -19], max: [200, 150, 0] };
const check = (src: string, wco: Vec3 = [-300, -300, -60], opts: Partial<{ laser: boolean; stock: Box3 | null }> = {}) =>
  runChecks({ tp: interpret(src).toolpath, wco, bounds, stock: opts.stock === undefined ? stock : opts.stock, toolRadius: 3, laser: opts.laser ?? false });

describe('stock setup', () => {
  it('places the stock box by origin mode', () => {
    const s = { size: { x: 100, y: 50, z: 10 }, origin: 'front-left-top' as const, color: '#fff' };
    expect(stockBox(s)).toEqual({ min: [0, 0, -10], max: [100, 50, 0] });
    expect(stockBox({ ...s, origin: 'center-top' })).toEqual({ min: [-50, -25, -10], max: [50, 25, 0] });
    expect(stockBox({ ...s, origin: 'front-left-bottom' })).toEqual({ min: [0, 0, 0], max: [100, 50, 10] });
  });

  it('assumes the stock lies on the bed near the front-left corner', () => {
    const s = defaultStock(router);
    const wco = assumedWco(router, s);
    const box = stockBox(s);
    // stock bottom (work) + wco = bed
    expect(box.min[2] + wco[2]).toBeCloseTo(bedZ(router));
    expect(box.min[0] + wco[0]).toBeGreaterThan(env.min.x);
    expect(box.max[0] + wco[0]).toBeLessThan(env.max.x);
  });
});

describe('collision and limit checks', () => {
  it('passes a job inside travel and stock', () => {
    const r = check('G0 Z5\nG0 X10 Y10\nG1 Z-5 F300\nG1 X100\nG0 Z5');
    expect(r.travel).toEqual([]);
    expect(r.belowStock).toBeNull();
    expect(r.rapidsThroughStock).toEqual([]);
  });

  it('reports travel overshoot per axis with the first line', () => {
    // wco X −300: X200 work → −100 machine OK; X350 → +50 past max (0)
    const r = check('G0 X10 Y10 Z5\nG1 X350 F500\nG0 Z90');
    expect(r.travel.map((t) => [t.axis, t.side, Math.round(t.amount), t.line])).toEqual([
      ['X', 'max', 50, 2],
      ['Z', 'max', 30, 3],
    ]);
    expect(r.problems.some((p) => p.kind === 'travel')).toBe(true);
  });

  it('checks arc bulges, not just end points', () => {
    // Full circle radius 150 around X150: reaches X300 work = 0 machine… and Y −150 → −450 machine (past −400)
    const r = check('G0 X0 Y0 Z5\nG2 X0 Y0 I150 J0 F500', [-300, -300, -60]);
    expect(r.travel.find((t) => t.axis === 'Y' && t.side === 'min')?.line).toBe(2);
  });

  it('detects cuts below the stock bottom, but not for lasers', () => {
    const src = 'G0 X10 Y10 Z5\nG1 Z-21 F200\nG1 X50\nG0 Z5';
    const r = check(src);
    expect(r.belowStock?.line).toBe(2);
    expect(r.belowStock?.maxDepth).toBeCloseTo(2, 3);
    expect(check(src, undefined, { laser: true }).belowStock).toBeNull();
  });

  it('detects rapids through the stock and ignores rapids above it', () => {
    // Lines: 1 up, 2 over (outside stock), 3 down beside it, 4 sideways THROUGH it, 5 retract, 6 above it
    const r = check('G0 Z5\nG0 X-10 Y10\nG0 Z-2\nG0 X50\nG0 Z5\nG0 X150');
    expect(r.rapidsThroughStock.map((x) => x.line)).toEqual([4]);
    // A plunge as a rapid straight down into the stock
    expect(check('G0 X50 Y50 Z5\nG0 Z-3').rapidsThroughStockCount).toBe(1);
    // Rapid exactly at the top surface is fine
    expect(check('G0 X-10 Y10 Z0\nG0 X250').rapidsThroughStockCount).toBe(0);
    // No stock defined: nothing to hit
    expect(check('G0 X-10 Y10 Z-2\nG0 X50', undefined, { stock: null }).rapidsThroughStockCount).toBe(0);
  });

  it('slab test handles axis-parallel and grazing segments', () => {
    const box: Box3 = { min: [0, 0, 0], max: [10, 10, 10] };
    expect(segmentHitsBox([-5, 5, 5], [15, 5, 5], box)).toBe(true);
    expect(segmentHitsBox([-5, 5, 10], [15, 5, 10], box)).toBe(false); // along the top face
    expect(segmentHitsBox([-5, -5, 5], [-1, 15, 5], box)).toBe(false);
    expect(segmentHitsBox([1, 1, 1], [2, 2, 2], box)).toBe(true); // fully inside
  });
});

describe('pre-flight with collision checks', () => {
  it('adds line numbers, below-stock and rapid warnings', async () => {
    const { analyze } = await import('@/lib/gcode/analyze');
    const { analysisChecks } = await import('@/lib/job/preflight');
    // 5: rapid sideways at Z-10 (inside the 19 mm stock); 6: cut to Z-21 (2 mm under it); 8: X past travel
    const text = 'G21 G90\nG0 Z5\nG0 X10 Y10\nG1 Z-10 F200\nG0 X60\nG1 Z-21 F200\nG0 Z5\nG0 X350';
    const a = analyze({ text, profile: router });
    const wco: Vec3 = [-300, -300, -60];
    const stockSetup = { size: { x: 200, y: 150, z: 19 }, origin: 'front-left-top' as const, color: '#fff' };
    const checks = runChecks({ tp: a.toolpath, wco, bounds, stock: stockBox(stockSetup), toolRadius: 3, laser: false });
    const status = { state: { name: 'idle' }, wco } as never;
    const out = analysisChecks(a, router, status, 'run', { checks, stock: stockSetup });
    expect(out.find((c) => c.id === 'bounds')!.detail).toMatch(/X goes 50\.0 mm past the maximum, first at line 8/);
    expect(out.find((c) => c.id === 'rapid-stock')!.detail).toMatch(/^Lines 5\./);
    expect(out.find((c) => c.id === 'below-stock')!.title).toMatch(/2\.00 mm below .* line 6/);
    expect(out.find((c) => c.id === 'stock')!.title).toMatch(/200\.0 × 150\.0 × 19\.0 mm, work zero at the front-left corner, top/);
  });
});
