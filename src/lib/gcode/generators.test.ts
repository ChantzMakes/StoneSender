import { describe, expect, it } from 'vitest';
import { drilling, outlineTrace, pocket, surfacing, type CutCommon } from './generators';
import { interpret } from './interpreter';

const common: CutCommon = { toolDiameter: 6, feed: 1200, plungeFeed: 300, rpm: 12000, clearance: 5, spinUp: 3 };

function run(text: string) {
  const r = interpret(text);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const tp = r.toolpath;
  let minZ = Infinity;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < tp.count; i++) {
    minZ = Math.min(minZ, tp.end[i * 4 + 2]!);
    if (tp.end[i * 4 + 2]! < 0) {
      xs.push(tp.end[i * 4]!);
      ys.push(tp.end[i * 4 + 1]!);
    }
  }
  return { r, minZ, x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] };
}

describe('generators', () => {
  it('surfacing covers the area in passes down to the full depth', () => {
    const g = surfacing({ ...common, x0: 0, y0: 0, x1: 100, y1: 50, stepoverPct: 40, depthPerPass: 0.5, totalDepth: 1.2, direction: 'x' });
    expect(g.errors).toEqual([]);
    const { minZ, x, y, r } = run(g.text);
    expect(minZ).toBeCloseTo(-1.2);
    expect(x).toEqual([0, 100]);
    expect(y).toEqual([0, 50]);
    expect(g.text).toContain('G4 P3');
    expect(r.final.pos[2]).toBeCloseTo(5);
    // 3 depth levels: 0.5, 1.0, 1.2
    expect(g.text.match(/G1 Z-/g)).toHaveLength(3);
  });

  it('rectangular pocket stays inside its walls', () => {
    const g = pocket({ ...common, shape: 'rect', cx: 50, cy: 30, width: 40, height: 20, diameter: 0, depth: 3, stepdown: 1, stepoverPct: 45 });
    expect(g.errors).toEqual([]);
    const { minZ, x, y } = run(g.text);
    expect(minZ).toBeCloseTo(-3);
    expect(x[0]).toBeCloseTo(50 - 20 + 3);
    expect(x[1]).toBeCloseTo(50 + 20 - 3);
    expect(y[0]).toBeCloseTo(30 - 10 + 3);
    expect(y[1]).toBeCloseTo(30 + 10 - 3);
  });

  it('circular pocket uses full circles out to the wall', () => {
    const g = pocket({ ...common, shape: 'circle', cx: 0, cy: 0, width: 0, height: 0, diameter: 30, depth: 2, stepdown: 2, stepoverPct: 40 });
    expect(g.errors).toEqual([]);
    const { x } = run(g.text);
    expect(x[1]).toBeCloseTo(15 - 3);
    expect(g.text).toMatch(/G3 X12 Y0 I-12 J0/);
  });

  it('rejects a pocket narrower than the tool', () => {
    expect(pocket({ ...common, shape: 'rect', cx: 0, cy: 0, width: 5, height: 20, diameter: 0, depth: 1, stepdown: 1, stepoverPct: 40 }).errors[0]).toContain('wider');
  });

  it('drills grids and circles with pecks', () => {
    const g = drilling({ ...common, pattern: 'grid', x0: 10, y0: 10, nx: 3, ny: 2, dx: 20, dy: 15, cx: 0, cy: 0, radius: 0, count: 0, startAngle: 0, depth: 5, peck: 2 });
    expect(g.errors).toEqual([]);
    const { minZ } = run(g.text);
    expect(minZ).toBeCloseTo(-5);
    expect(g.text.match(/G1 Z-5 /g)).toHaveLength(6);
    expect(g.text.match(/G1 Z-2 /g)).toHaveLength(6);
    const c = drilling({ ...common, pattern: 'circle', x0: 0, y0: 0, nx: 0, ny: 0, dx: 0, dy: 0, cx: 50, cy: 50, radius: 20, count: 4, startAngle: 0, depth: 3, peck: 0 });
    expect(c.text).toContain('G0 X70 Y50');
    expect(c.text).toContain('G0 X50 Y70');
  });

  it('outline trace runs around the job with the spindle off', () => {
    const g = outlineTrace({ min: [0, 0, -3], max: [40, 30, 0] }, 10, 2000, 'part');
    expect(g.name).toBe('part-outline.nc');
    const r = interpret(g.text);
    expect(r.final.pos[2]).toBeCloseTo(10);
    expect(g.text).toContain('G1 X40 Y30');
    expect(g.text).not.toMatch(/M3/);
  });
});
