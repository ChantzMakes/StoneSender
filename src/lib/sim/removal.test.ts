import { describe, expect, it } from 'vitest';
import { interpret } from '@/lib/gcode/interpreter';
import { plan, type PlannerConfig } from '@/lib/gcode/planner';
import { segmentEndTimes } from '@/lib/gcode/render';
import { FLAG_GOUGE, RemovalSim, type RemovalConfig } from './removal';
import { defaultTools, toolProfile, ToolSchema, widthAtDepth, type Tool } from './tools';

const cfg: PlannerConfig = { maxRate: [6000, 6000, 1200, 3600], accel: [500, 500, 200, 100], junctionDeviation: 0.01, arcTolerance: 0.002, plannerBlocks: 15 };
const tool = (over: Partial<Tool>): Tool => ToolSchema.parse({ id: 't', number: 1, name: 't', kind: 'flat', diameter: 6, fluteLength: 20, stickout: 30, ...over });

function sim(src: string, t: Tool, over: Partial<RemovalConfig> = {}) {
  const r = interpret(src, { aAxis: true });
  plan(r.toolpath, cfg, r.sourceLines);
  const segEnd = segmentEndTimes(r.toolpath);
  const s = new RemovalSim(r.toolpath, segEnd, {
    mode: 'router',
    stockMin: [0, 0, -20],
    stockMax: [100, 100, 0],
    resolution: 0.25,
    tools: [t],
    jobTools: {},
    defaultToolId: t.id,
    laserMaxPower: 1000,
    ...over,
  });
  return { s, total: segEnd[segEnd.length - 1] ?? 0 };
}

const heightAt = (s: RemovalSim, x: number, y: number) => {
  const g = s.grid;
  const i = Math.floor((x - g.x0) / g.res);
  const j = Math.floor((y - g.y0) / g.resY);
  return s.data[j * g.nx + i]!;
};

describe('tool shapes', () => {
  it('profiles flat, ball, V, engraver, drill', () => {
    expect(toolProfile({ kind: 'flat', diameter: 6, angle: 90, tipDiameter: 0 })(2.9)).toBe(0);
    expect(toolProfile({ kind: 'flat', diameter: 6, angle: 90, tipDiameter: 0 })(3.1)).toBe(Infinity);
    expect(toolProfile({ kind: 'ball', diameter: 6, angle: 90, tipDiameter: 0 })(3)).toBeCloseTo(3);
    expect(toolProfile({ kind: 'vbit', diameter: 12, angle: 90, tipDiameter: 0 })(2)).toBeCloseTo(2);
    expect(toolProfile({ kind: 'engraver', diameter: 3, angle: 30, tipDiameter: 0.2 })(0.1)).toBe(0);
    expect(widthAtDepth(tool({ kind: 'vbit', diameter: 12, angle: 90 }), 2)).toBeCloseTo(4, 3);
    expect(defaultTools().length).toBeGreaterThan(5);
  });
});

describe('router heightmap removal', () => {
  it('a flat slot has the cutter width and depth; volume adds up', () => {
    const { s, total } = sim('G0 X20 Y50 Z5\nG1 Z-3 F200\nG1 X80 F1000\nG0 Z5', tool({}));
    s.advanceTo(total);
    expect(heightAt(s, 50, 50)).toBeCloseTo(-3);
    expect(heightAt(s, 50, 52.8)).toBeCloseTo(-3);
    expect(heightAt(s, 50, 53.3)).toBe(0);
    // slot ≈ 60 × 6 × 3 + two half-circle ends ≈ 1080 + 85
    expect(s.removedVolume).toBeGreaterThan(1100);
    expect(s.removedVolume).toBeLessThan(1220);
  });

  it('ball and V-bit leave their shapes', () => {
    const ball = sim('G0 X50 Y50 Z5\nG1 Z-3 F200\nG0 Z5', tool({ kind: 'ball' }));
    ball.s.advanceTo(ball.total);
    expect(heightAt(ball.s, 50, 50)).toBeCloseTo(-3, 1);
    // compare at the centre of the cell the sample falls in
    const cx = (Math.floor(52 / ball.s.grid.res) + 0.5) * ball.s.grid.res;
    const cy = (Math.floor(50 / ball.s.grid.resY) + 0.5) * ball.s.grid.resY;
    const d = Math.hypot(cx - 50, cy - 50);
    expect(heightAt(ball.s, 52, 50)).toBeCloseTo(-3 + 3 - Math.sqrt(9 - d * d), 2);
    const v = sim('G0 X50 Y50 Z5\nG1 Z-2 F200\nG0 Z5', tool({ kind: 'vbit', diameter: 12, angle: 90 }));
    v.s.advanceTo(v.total);
    const vx = (Math.floor(51 / v.s.grid.res) + 0.5) * v.s.grid.res;
    const vy = (Math.floor(50 / v.s.grid.resY) + 0.5) * v.s.grid.resY;
    expect(heightAt(v.s, 51, 50)).toBeCloseTo(-2 + Math.hypot(vx - 50, vy - 50), 2); // 90° V: depth = −2 + d
    expect(heightAt(v.s, 52.5, 50)).toBe(0);
  });

  it('advances by time, part-way through a move, and restores keyframes', () => {
    const { s, total } = sim('G0 X10 Y50 Z5\nG1 Z-1 F600\nG1 X90 F600\nG0 Z5', tool({}));
    // Find the time when the long cut is about halfway.
    s.advanceTo(total * 0.5);
    const mid = s.snapshot();
    const cutSoFar = [...Array(100).keys()].filter((x) => heightAt(s, x + 0.5, 50) < 0).length;
    expect(cutSoFar).toBeGreaterThan(10);
    expect(cutSoFar).toBeLessThan(80);
    s.advanceTo(total);
    expect(heightAt(s, 89, 50)).toBeCloseTo(-1);
    s.restore(mid);
    expect(heightAt(s, 89, 50)).toBe(0);
    s.advanceTo(total);
    expect(heightAt(s, 89, 50)).toBeCloseTo(-1);
  });

  it('detects rapid gouges, cuts below the stock, short flutes and holder collisions', () => {
    const g = sim('G0 Z5\nG0 X10 Y50\nG0 Z-2\nG0 X40\nG0 Z5', tool({}));
    g.s.advanceTo(g.total);
    expect(g.s.events.find((e) => e.kind === 'rapid-gouge')?.line).toBe(3);
    expect(g.s.flags.some((f) => (f & FLAG_GOUGE) !== 0)).toBe(true);

    const below = sim('G0 X50 Y50 Z5\nG1 Z-22 F200\nG0 Z5', tool({}));
    below.s.advanceTo(below.total);
    expect(below.s.events.find((e) => e.kind === 'below-stock')?.line).toBe(2);
    expect(heightAt(below.s, 50, 50)).toBe(-20); // can't go below the stock

    const deep = sim('G0 X10 Y50 Z5\nG1 Z-15 F200\nG1 X60 F600\nG0 Z5', tool({ fluteLength: 10, stickout: 40 }));
    deep.s.advanceTo(deep.total);
    expect(deep.s.events.find((e) => e.kind === 'flute')?.line).toBeGreaterThanOrEqual(2);

    const holder = sim('G0 X10 Y50 Z5\nG1 Z-15 F200\nG1 X60 F600\nG0 Z5', tool({ fluteLength: 20, stickout: 12, holderDiameter: 20 }));
    holder.s.advanceTo(holder.total);
    expect(holder.s.events.find((e) => e.kind === 'holder')).toBeTruthy();
  });

  it('finds small islands left inside a pocket', () => {
    // Ring passes (r = 7, 10, 13 with a 6 mm bit) leave a Ø8 mm island in the middle.
    // Start on the first ring so no move crosses the centre.
    let src = 'G0 X57 Y50 Z5\nG1 Z-2 F300\n';
    for (const r of [7, 10, 13]) src += `G1 X${50 + r} Y50 F1000\nG2 X${50 + r} Y50 I-${r} J0\n`;
    src += 'G0 Z5\n';
    const { s, total } = sim(src, tool({}));
    s.advanceTo(total);
    const isl = s.findIslands(200);
    expect(isl.count).toBe(1);
    expect(isl.centers[0]![0]).toBeCloseTo(50, 0);
  });

  it('uses the library tool assigned to each T number', () => {
    const small = tool({ id: 'small', number: 2, diameter: 2 });
    const big = tool({ id: 'big', number: 1, diameter: 10 });
    const { s, total } = sim('T2 M6\nG0 X50 Y50 Z5\nG1 Z-1 F200\nG0 Z5', big, { tools: [big, small], jobTools: { 2: 'small' }, defaultToolId: 'big' });
    s.advanceTo(total);
    expect(heightAt(s, 51.5, 50)).toBe(0); // 2 mm bit, not the 10 mm default
  });
});

describe('laser burn and rotary', () => {
  it('burns darker with more power and less speed', () => {
    const src = 'M4 S0\nG0 X10 Y10\nG1 X90 S1000 F1000\nG0 Y20\nG1 X10 S500 F1000\nG0 Y30\nG1 X90 S1000 F3000\nM5';
    const { s, total } = sim(src, tool({}), { mode: 'laser', resolution: 0.1, laserSpot: 0.2 });
    s.advanceTo(total);
    const e1 = heightAt(s, 50, 10);
    const e2 = heightAt(s, 50, 20);
    const e3 = heightAt(s, 50, 30);
    expect(e1).toBeGreaterThan(0);
    expect(e2).toBeCloseTo(e1 / 2, 2);
    expect(e3).toBeCloseTo(e1 / 3, 2);
    expect(heightAt(s, 50, 15)).toBe(0); // travel at S0 doesn't burn
  });

  it('turns a rotary groove all the way round the cylinder', () => {
    const src = 'G0 Z30\nG0 X20 A0\nG1 Z23 F300\nG1 A360 F2000\nG0 Z30';
    const { s, total } = sim(src, tool({}), { mode: 'rotary', stockMin: [0, -25, -25], stockMax: [100, 25, 25], rotaryRadius: 25, resolution: 0.5 });
    s.advanceTo(total);
    const g = s.grid;
    const i = Math.floor((20 - g.x0) / g.res);
    for (const frac of [0.1, 0.35, 0.6, 0.85]) {
      const j = Math.floor(frac * g.ny);
      expect(s.data[j * g.nx + i]).toBeCloseTo(23, 0);
    }
    const iFar = Math.floor((60 - g.x0) / g.res);
    expect(s.data[iFar]).toBe(25);
  });
});
