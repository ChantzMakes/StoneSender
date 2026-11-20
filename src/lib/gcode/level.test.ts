import { describe, expect, it } from 'vitest';
import { interpret } from './interpreter';
import { heightAt, levelGcode, type HeightMap } from './level';

// Surface rising 0.02 mm per mm in X, 0 at X0
const tilt: HeightMap = { x0: 0, y0: 0, dx: 50, dy: 50, nx: 3, ny: 2, z: [0, 1, 2, 0, 1, 2] };

describe('auto-leveling', () => {
  it('interpolates bilinearly and clamps outside the grid', () => {
    expect(heightAt(tilt, 25, 10)).toBeCloseTo(0.5);
    expect(heightAt(tilt, 100, 50)).toBeCloseTo(2);
    expect(heightAt(tilt, 500, -20)).toBeCloseTo(2);
    const saddle: HeightMap = { x0: 0, y0: 0, dx: 10, dy: 10, nx: 2, ny: 2, z: [0, 1, 1, 0] };
    expect(heightAt(saddle, 5, 5)).toBeCloseTo(0.5);
  });

  it('splits long moves and lifts Z to follow the surface', () => {
    const r = levelGcode('G21 G90\nM3 S10000\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X100 F800\nM5', tilt, { segment: 10 });
    expect(r.errors).toEqual([]);
    const out = interpret(r.text);
    const tp = out.toolpath;
    // every end point sits 1 mm below the surface
    for (let i = 0; i < tp.count; i++) {
      const x = tp.end[i * 4]!;
      const z = tp.end[i * 4 + 2]!;
      if (tp.line[i]! > 4 && z < 4) expect(z).toBeCloseTo(-1 + x * 0.02, 3);
    }
    expect(r.text.split('\n').filter((l) => l.startsWith('G1 X')).length).toBeGreaterThanOrEqual(10);
    expect(r.text).toContain('M3 S10000');
    expect(r.maxCorrection).toBeCloseTo(2);
  });

  it('turns arcs into lines that end where the arc did', () => {
    const r = levelGcode('G21 G90\nG0 X10 Y0 Z0\nG1 Z-1 F100\nG3 X-10 Y0 I-10 J0\nG2 X10 Y0 R10', { x0: -20, y0: -20, dx: 40, dy: 40, nx: 2, ny: 2, z: [0, 0, 0, 0] });
    expect(r.errors).toEqual([]);
    expect(r.text).not.toMatch(/G[23] /);
    const ends = interpret(r.text).final.pos;
    expect(ends[0]).toBeCloseTo(10, 3);
    expect(ends[1]).toBeCloseTo(0, 3);
    // points stay on the circle
    const pts = r.text.split('\n').filter((l) => l.startsWith('G1 X')).map((l) => l.match(/X(-?[\d.]+) Y(-?[\d.]+)/)!.slice(1).map(Number));
    for (const [x, y] of pts) expect(Math.hypot(x!, y!)).toBeCloseTo(10, 2);
  });

  it('keeps inch jobs in inches and refuses incremental moves', () => {
    const r = levelGcode('G20 G90\nG0 X0 Y0 Z0.1\nG1 X2 Z-0.04 F20', tilt, { segment: 100 });
    // X2" = 50.8 mm → +1.016 mm = 0.04" lift
    expect(r.text).toContain('G1 X2 Y0 Z0 F20');
    const bad = levelGcode('G21 G91\nG1 X10 F100', tilt);
    expect(bad.errors[0]).toContain('G91');
  });
});
