import { describe, expect, it } from 'vitest';
import { interpret } from './interpreter';
import { transformGcode, type Transform } from './transform';

const JOB = ['G21 G90 G17', 'M3 S10000', 'G0 X10 Y0 Z5 (start)', 'G1 Z-1 F300', 'G1 X30 F1000', 'G3 X30 Y20 I0 J10', 'G1 X10', 'Y5', 'G2 X10 Y15 R5', 'G0 Z5', 'M5'].join('\n');

function ends(text: string) {
  const r = interpret(text);
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const tp = r.toolpath;
  return Array.from({ length: tp.count }, (_, i) => [tp.end[i * 4]!, tp.end[i * 4 + 1]!, tp.end[i * 4 + 2]!, tp.kind[i]!] as const);
}

function check(t: Transform, map: (x: number, y: number, z: number) => [number, number, number], kindsSwap = false) {
  const r = transformGcode(JOB, t);
  expect(r.errors).toEqual([]);
  const a = ends(JOB);
  const b = ends(r.text);
  expect(b.length).toBe(a.length);
  a.forEach(([x, y, z, k], i) => {
    const [ex, ey, ez] = map(x, y, z);
    expect(b[i]![0]).toBeCloseTo(ex, 3);
    expect(b[i]![1]).toBeCloseTo(ey, 3);
    expect(b[i]![2]).toBeCloseTo(ez, 3);
    const swapped = k === 2 ? 3 : k === 3 ? 2 : k;
    expect(b[i]![3]).toBe(kindsSwap ? swapped : k);
  });
  return r;
}

describe('G-code transforms', () => {
  it('translates, keeping arcs as arcs', () => {
    const r = check({ kind: 'translate', dx: 5, dy: -3, dz: 1 }, (x, y, z) => [x + 5, y - 3, z + 1]);
    expect(r.text).toContain('(start)');
  });

  it('rotates about a point (arcs stay arcs, modal moves get both axes)', () => {
    const rot = (x: number, y: number): [number, number] => {
      const dx = x - 10;
      const dy = y - 0;
      return [10 - dy, 0 + dx];
    };
    check({ kind: 'rotate', angleDeg: 90, cx: 10, cy: 0 }, (x, y, z) => [...rot(x, y), z]);
  });

  it('mirrors and swaps arc directions', () => {
    check({ kind: 'mirror', axis: 'x', about: 0 }, (x, y, z) => [-x, y, z], true);
    check({ kind: 'mirror', axis: 'y', about: 10 }, (x, y, z) => [x, 20 - y, z], true);
  });

  it('scales uniformly (arcs kept) and non-uniformly (arcs become lines)', () => {
    check({ kind: 'scale', sx: 2, sy: 2, sz: 1, cx: 0, cy: 0 }, (x, y, z) => [2 * x, 2 * y, z]);
    const r = transformGcode(JOB, { kind: 'scale', sx: 2, sy: 1, sz: 1, cx: 0, cy: 0 });
    expect(r.errors).toEqual([]);
    expect(r.text).not.toMatch(/\bG[23]\b/);
    const f = interpret(r.text).final.pos;
    expect(f[0]).toBeCloseTo(20, 3);
    expect(f[1]).toBeCloseTo(15, 3);
  });

  it('converts arcs to lines within the tolerance', () => {
    const r = transformGcode(JOB, { kind: 'arcs-to-lines', tolerance: 0.01 });
    expect(r.text).not.toMatch(/\bG[23]\b/);
    const pts = r.text.split('\n').filter((l) => l.includes('G1 X') && l.includes('Z-1')).map((l) => l.match(/X(-?[\d.]+) Y(-?[\d.]+)/)!.slice(1).map(Number));
    // the G3 arc around (30, 10), radius 10
    const onFirstArc = pts.filter(([x]) => x! > 30.001);
    expect(onFirstArc.length).toBeGreaterThan(10);
    for (const [x, y] of onFirstArc) expect(Math.hypot(x! - 30, y! - 10)).toBeCloseTo(10, 2);
    expect(interpret(r.text).final.pos[1]).toBeCloseTo(15, 3);
  });

  it('scales feeds only', () => {
    const r = transformGcode(JOB, { kind: 'feed', factor: 0.5 });
    expect(r.text).toContain('G1 X30 F500');
    expect(r.text).toContain('G1 Z-1 F150');
    expect(r.changed).toBe(2);
  });

  it('inch files: amounts are mm; incremental moves get the linear part only', () => {
    const r = transformGcode('G20 G90\nG0 X1 Y1', { kind: 'translate', dx: 25.4, dy: 0, dz: 0 });
    expect(r.text).toContain('G0 X2 Y1');
    const rel = transformGcode('G21 G91\nG1 X10 F100', { kind: 'rotate', angleDeg: 90, cx: 50, cy: 50 });
    expect(rel.text).toContain('G1 F100 X0 Y10');
    const tr = transformGcode('G21 G91\nG1 X10 F100', { kind: 'translate', dx: 5, dy: 5, dz: 0 });
    expect(tr.text).toContain('X10');
  });
});
