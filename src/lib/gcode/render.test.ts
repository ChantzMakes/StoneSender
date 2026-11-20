import { describe, expect, it } from 'vitest';
import { interpret } from './interpreter';
import { plan, type PlannerConfig } from './planner';
import { buildRenderGeometry, buildSnapIndex, DKIND, niceStep, sampleAt, timeAtLineStart } from './render';

const cfg: PlannerConfig = { maxRate: [6000, 6000, 1200, 3600], accel: [500, 500, 200, 100], junctionDeviation: 0.01, arcTolerance: 0.002, plannerBlocks: 15 };
const prep = (src: string) => {
  const r = interpret(src);
  const p = plan(r.toolpath, cfg, r.sourceLines);
  return { tp: r.toolpath, p };
};

describe('render geometry', () => {
  it('emits vertex pairs with kinds, feeds and monotonic times', () => {
    const { tp, p } = prep('G0 X10 Y10 Z5\nG1 Z-2 F200\nG1 X30 F800\nG4 P1\nG0 Z5');
    const g = buildRenderGeometry(tp);
    expect(g.vertexCount).toBe(8);
    expect(Array.from(g.kind.filter((_, i) => i % 2 === 0))).toEqual([DKIND.rapid, DKIND.plunge, DKIND.feed, DKIND.rapid]);
    expect(Array.from(g.positions.slice(6, 12))).toEqual([10, 10, 5, 10, 10, -2]);
    expect(g.feed[2]).toBe(200);
    for (let i = 1; i < g.vertexCount; i++) expect(g.time[i]! + 1e-6).toBeGreaterThanOrEqual(g.time[i - 1]!);
    expect(g.time[g.vertexCount - 1]).toBeCloseTo(p.totalSeconds, 3);
  });

  it('tessellates arcs that end exactly at the arc end point', () => {
    const { tp } = prep('G0 X10\nG2 X-10 Y0 I-10 J0 F600');
    const g = buildRenderGeometry(tp, { arcTolerance: 0.01 });
    const n = g.vertexCount / 2 - 1;
    expect(n).toBeGreaterThan(20);
    const last = g.positions.slice((g.vertexCount - 1) * 3, g.vertexCount * 3);
    expect(Array.from(last).map((v) => Math.round(v * 1000) / 1000)).toEqual([-10, 0, 0]);
    // Every arc vertex is on the circle (CW from (10,0) passes through y < 0)
    let minY = 0;
    for (let i = 2; i < g.vertexCount; i++) {
      const x = g.positions[i * 3]!;
      const y = g.positions[i * 3 + 1]!;
      expect(Math.hypot(x, y)).toBeCloseTo(10, 3);
      minY = Math.min(minY, y);
    }
    expect(minY).toBeCloseTo(-10, 1);
  });

  it('draws laser moves with the beam off as travel', () => {
    const { tp } = prep('M4 S0\nG1 X10 F1000\nG1 X20 S500\nM5');
    const g = buildRenderGeometry(tp, { laser: true });
    expect([g.kind[0], g.kind[2]]).toEqual([DKIND.rapid, DKIND.feed]);
    expect(g.power[2]).toBe(500);
  });

  it('merges tiny segments above the LOD threshold but keeps the path ends', () => {
    const src = Array.from({ length: 2000 }, (_, i) => `G1 X${((i + 1) * 0.01).toFixed(2)} Y${Math.sin(i / 50).toFixed(3)} F1000`).join('\n') + '\nG0 X300';
    const { tp } = prep(src);
    const full = buildRenderGeometry(tp);
    const lod = buildRenderGeometry(tp, { lodThreshold: 100 });
    expect(lod.decimated).toBe(true);
    expect(lod.vertexCount).toBeLessThan(full.vertexCount / 2);
    expect(lod.positions[lod.vertexCount * 3 - 3]).toBeCloseTo(300, 3);
  });
});

describe('playback sampling', () => {
  it('interpolates along lines and arcs and reports the source line', () => {
    const { tp, p } = prep('G0 X100\nG2 X120 Y0 I10 J0 F600');
    const g = buildRenderGeometry(tp);
    expect(sampleAt(tp, g.segEnd, 0).pos.slice(0, 3)).toEqual([0, 0, 0]);
    const mid = sampleAt(tp, g.segEnd, tp.duration[0]! / 2);
    expect(mid.line).toBe(1);
    expect(mid.pos[0]).toBeGreaterThan(40);
    expect(mid.pos[0]).toBeLessThan(60);
    const arcMid = sampleAt(tp, g.segEnd, tp.duration[0]! + tp.duration[1]! / 2);
    expect(arcMid.line).toBe(2);
    expect(arcMid.pos[0]).toBeCloseTo(110, 1);
    expect(arcMid.pos[1]).toBeCloseTo(10, 1); // CW half circle from (100,0) around (110,0) passes over the top
    const endPos = sampleAt(tp, g.segEnd, p.totalSeconds + 10).pos;
    expect(endPos[0]).toBeCloseTo(120, 6);
    expect(endPos[1]).toBeCloseTo(0, 4);
  });

  it('follows the acceleration profile within a move', () => {
    // 100 mm at 100 mm/s, 500 mm/s²: 0.2 s accel (10 mm), 0.8 s cruise, 0.2 s decel.
    const { tp } = prep('G0 X100');
    const g = buildRenderGeometry(tp);
    const at = (t: number) => sampleAt(tp, g.segEnd, t).pos[0];
    expect(at(0.1)).toBeCloseTo(0.5 * 500 * 0.01, 2); // ½at² = 2.5 mm, not 100/12
    expect(at(0.2)).toBeCloseTo(10, 2);
    expect(at(0.6)).toBeCloseTo(50, 2);
    expect(at(1.1)).toBeCloseTo(100 - 2.5, 2);
    expect(at(1.2)).toBeCloseTo(100, 4);
  });

  it('maps lines to start times', () => {
    const { p } = prep('G0 X100\nG4 P1\nG0 X0');
    expect(timeAtLineStart(p.lineEndTime, 1)).toBe(0);
    expect(timeAtLineStart(p.lineEndTime, 3)).toBeCloseTo(p.lineEndTime[2]!, 6);
  });
});

describe('measuring helpers', () => {
  it('snaps to the nearest endpoint and picks nice ruler steps', () => {
    const { tp } = prep('G0 X10 Y10 Z5\nG1 X40 Y10 Z-1 F100');
    const s = buildSnapIndex(tp, 2);
    expect(s.nearest(39.2, 10.5, 3)).toEqual([40, 10, -1]);
    expect(s.nearest(25, 25, 3)).toBeNull();
    expect(niceStep(100)).toBe(10);
    expect(niceStep(37)).toBe(5);
    expect(niceStep(1500)).toBe(200);
    expect(niceStep(0)).toBe(1);
  });
});
