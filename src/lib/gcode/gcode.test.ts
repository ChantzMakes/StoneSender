import { describe, expect, it } from 'vitest';
import { profileFromPreset } from '@/lib/profile/presets';
import { analyze } from './analyze';
import { interpret, splitLines, stateBeforeLine, tokenize, workOffset } from './interpreter';
import { blockTime, plan, type PlannerConfig } from './planner';
import { computeStats } from './stats';
import { SEG, segStart } from './toolpath';

const run = (src: string, opts = {}) => interpret(src, opts);
const ends = (src: string, opts = {}) => {
  const r = run(src, opts);
  return Array.from({ length: r.toolpath.count }, (_, i) => Array.from(r.toolpath.end.slice(i * 4, i * 4 + 3)).map((v) => Number(v.toFixed(4))));
};
const errors = (src: string, opts = {}) => run(src, opts).diagnostics.filter((d) => d.severity === 'error');

describe('tokenizer', () => {
  it('strips comments and whitespace like GRBL', () => {
    expect(tokenize('g1 x 1 0 (comment) Y-.5 ; tail').words).toEqual([
      { letter: 'G', value: 1 },
      { letter: 'X', value: 10 },
      { letter: 'Y', value: -0.5 },
    ]);
    expect(tokenize('X1.2.3').error?.code).toBe(2);
    expect(tokenize('#1=5').error?.code).toBe(1);
    expect(tokenize('X').error?.code).toBe(2);
    expect(tokenize('(only a comment)').words).toEqual([]);
  });

  it('splits lines like Rust str::lines', () => {
    expect(splitLines('a\r\nb\n\nc\n')).toEqual(['a', 'b', '', 'c']);
  });
});

describe('interpreter: modal state and coordinates', () => {
  it('keeps the motion mode, distance mode and units modal', () => {
    expect(ends('G0 X10\nY5\nG91 X1\nG90 G20 X1\nG21 Z-2')).toEqual([
      [10, 0, 0],
      [10, 5, 0],
      [11, 5, 0],
      [25.4, 5, 0],
      [25.4, 5, -2],
    ]);
  });

  it('feed is converted to mm/min in inch mode and inverse time computes feed from length', () => {
    const r = run('G20 G1 X1 F10\nG21 G93 G1 X35.4 F2\nG94');
    expect(r.toolpath.feed[0]).toBeCloseTo(254);
    expect(r.toolpath.feed[1]).toBeCloseTo(20); // 10 mm in 1/2 minute
    expect(errors('G93 G1 X5\n').length).toBe(1);
  });

  it('applies work offsets, G10 L20, G92, G53 and TLO', () => {
    const offsets = { wcs: [[-100, -100, -50, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] as [number, number, number, number][] };
    expect(ends('G0 X0 Y0 Z0', { offsets })).toEqual([[-100, -100, -50]]);
    // G10 L20: current position becomes X5 in G54
    const r = run('G0 X0 Y0 Z0\nG10 L20 P1 X5\nG0 X5', { offsets });
    expect(r.toolpath.count).toBe(1);
    expect(r.final.offsets.wcs[0]![0]).toBe(-105);
    expect(ends('G92 X10\nG0 X0', { offsets: { wcs: offsets.wcs } })).toEqual([[-10, 0, 0]]);
    expect(ends('G53 G0 X-3 Y-4\nG43.1 Z2\nG0 Z0', { offsets })).toEqual([
      [-3, -4, 0],
      [-3, -4, -48],
    ]);
    const wo = run('G55', { offsets }).final;
    expect(workOffset(wo)).toEqual([0, 0, 0, 0]);
  });

  it('G28 / G30 go via the intermediate point to the stored position', () => {
    expect(ends('G0 X10 Y10 Z5\nG28.1\nG0 X0 Y0 Z0\nG28 Z2')).toEqual([
      [10, 10, 5],
      [0, 0, 0],
      [0, 0, 2],
      [0, 0, 5],
    ]);
  });

  it('records tool changes, pauses and program end resets modes', () => {
    const r = run('T3 M6\nG91\nM0\nG0 X1\nM30\nG0 X5');
    expect(r.toolChanges).toEqual([{ line: 1, tool: 3 }]);
    expect(r.pauses).toEqual([3]);
    // after M30 G90 is restored, so X5 is absolute (G91 would give 6)
    expect(Array.from(r.toolpath.end.slice(4, 5))).toEqual([5]);
    expect(r.diagnostics.some((d) => d.message.includes('after the program end'))).toBe(true);
  });

  it('marks sync points for spindle and coolant changes (but not S in laser mode)', () => {
    const router = run('M3 S1000\nG1 X1 F100\nS2000\nG1 X2\nM8\nG1 X3');
    expect(Array.from(router.toolpath.flags).map((f) => f & 1)).toEqual([1, 1, 1]);
    const laser = run('M4 S100\nG1 X1 F100\nG1 X2 S500\nG1 X3 S900', { laserMode: true });
    expect(Array.from(laser.toolpath.flags).map((f) => f & 1)).toEqual([0, 0, 0]);
    expect(Array.from(laser.toolpath.spindle)).toEqual([100, 500, 900]);
  });
});

describe('interpreter: arcs', () => {
  it('handles IJK arcs in all planes, CW and CCW, full circles and helices', () => {
    const xy = run('G17 G2 X20 Y0 I10 J0 F100');
    expect(xy.toolpath.kind[0]).toBe(SEG.arcCw);
    expect(xy.toolpath.arcs[3]).toBeCloseTo(-Math.PI);
    const full = run('G0 X10\nG3 X10 Y0 I-10 J0 F100');
    expect(full.toolpath.arcs[3]).toBeCloseTo(2 * Math.PI);
    const zx = run('G18 G2 X-20 Z0 I-10 K0 F100');
    expect(zx.diagnostics).toEqual([]);
    expect(zx.toolpath.arcs[4]).toBe(1);
    const yz = run('G19 G3 Y-20 Z0 J-10 K0 F100');
    expect(yz.diagnostics).toEqual([]);
    const helix = run('G0 X10\nG2 X10 Y0 Z-5 I-10 J0 F100');
    expect(Array.from(helix.toolpath.end.slice(4, 7))).toEqual([10, 0, -5]);
  });

  it('handles R arcs including the long way round', () => {
    const short = run('G2 X10 Y10 R10 F100');
    const long = run('G2 X10 Y10 R-10 F100');
    expect(Math.abs(short.toolpath.arcs[3]!)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(long.toolpath.arcs[3]!)).toBeCloseTo((3 * Math.PI) / 2);
  });

  it('reports arc errors with GRBL codes', () => {
    expect(errors('G2 X20 Y0 R5 F100')[0]!.code).toBe(34);
    expect(errors('G2 X20 Y0 F100')[0]!.code).toBe(35);
    expect(errors('G2 X20 Y0 I5 J0 F100')[0]!.code).toBe(33);
    expect(errors('G2 F100')[0]!.code).toBe(32);
  });
});

describe('interpreter: GRBL errors', () => {
  it.each([
    ['G1 X10', 22],
    ['G0 G1 X1', 21],
    ['G0 X1 X2', 25],
    ['G41 D1', 20],
    ['G81 Z-1 R1 F10', 20],
    ['M7 M9', 21],
    ['G4', 28],
    ['G10 L3 P1 X0', 20],
    ['G53 G2 X1 I1 F10', 30],
    ['G80 X1', 31],
    ['O100', 20],
    ['G0 A10', 20],
  ])('%s → error %i', (src, code) => {
    expect(errors(src)[0]?.code).toBe(code);
  });

  it('a rejected line leaves no partial segments or state changes', () => {
    const r = run('G4 P1 G1 X5\nG0 X1');
    expect(r.toolpath.count).toBe(1);
    expect(r.toolpath.kind[0]).toBe(SEG.rapid);
    expect(r.final.modal.motion).toBe('G0');
  });

  it('accepts A axis words on a 4-axis machine', () => {
    expect(run('G0 A90', { aAxis: true }).diagnostics).toEqual([]);
  });
});

describe('start-from-line state', () => {
  it('matches a full interpretation up to that line', () => {
    const lines = ['G21 G90', 'G0 X1 Y1', 'G91', 'M3 S500'];
    for (let i = 0; i < 3000; i++) lines.push(`G1 X0.1 F${100 + (i % 7)}`);
    lines.push('G90 G20');
    const text = lines.join('\n');
    const r = interpret(text, { checkpointEvery: 500 });
    expect(r.checkpoints.length).toBeGreaterThan(4);
    const s = stateBeforeLine(text, r, 2500);
    const direct = interpret(lines.slice(0, 2499).join('\n')).final;
    expect(s.pos[0]).toBeCloseTo(direct.pos[0]);
    expect(s.modal).toEqual(direct.modal);
  });
});

const cfg = (over: Partial<PlannerConfig> = {}): PlannerConfig => ({
  maxRate: [6000, 6000, 1200, 3600],
  accel: [500, 500, 200, 100],
  junctionDeviation: 0.01,
  arcTolerance: 0.002,
  plannerBlocks: 15,
  ...over,
});

describe('planner', () => {
  it('trapezoid and triangle block times', () => {
    // 100 mm at 100 mm/s with 500 mm/s²: 1.0 + 0.2 = 1.2 s
    expect(blockTime(100, 0, 0, 100, 500)).toBeCloseTo(1.2);
    // too short to reach cruise: triangle
    expect(blockTime(5, 0, 0, 100, 500)).toBeCloseTo(2 * Math.sqrt(5 / 500));
  });

  it('a single rapid matches the analytic time', () => {
    const r = run('G0 X100');
    expect(plan(r.toolpath, cfg(), r.sourceLines).totalSeconds).toBeCloseTo(1.2, 3);
  });

  it('collinear segments run at full speed through junctions', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `G1 X${(i + 1) * 10} F6000`).join('\n');
    const r = run(lines);
    expect(plan(r.toolpath, cfg(), r.sourceLines).totalSeconds).toBeCloseTo(1.2, 2);
  });

  it('sharp corners and tiny segments slow the machine down', () => {
    const square = run('G1 X50 F6000\nY50\nX0\nY0');
    const t = plan(square.toolpath, cfg(), square.sourceLines).totalSeconds;
    expect(t).toBeGreaterThan(4 * (0.5 + 0.2) * 0.95); // essentially stops at each 90° corner
    // 1000 × 0.05 mm segments: lookahead of 15 blocks (0.75 mm) caps speed far below 100 mm/s
    const tiny = run(Array.from({ length: 1000 }, (_, i) => `G1 X${((i + 1) * 0.05).toFixed(2)} F6000`).join('\n'));
    const tt = plan(tiny.toolpath, cfg(), tiny.sourceLines).totalSeconds;
    const vmax = Math.sqrt(2 * 500 * 0.75);
    expect(tt).toBeGreaterThan(50 / vmax * 0.9);
    const big = plan(tiny.toolpath, cfg({ plannerBlocks: 200 }), tiny.sourceLines).totalSeconds;
    expect(big).toBeLessThan(tt);
  });

  it('dwells, spindle sync and arcs', () => {
    const d = run('G4 P2.5');
    expect(plan(d.toolpath, cfg(), d.sourceLines).totalSeconds).toBeCloseTo(2.5);
    // Half circle r=10 at F600 (10 mm/s): length 31.4 mm ≈ 3.14 s + accel
    const arc = run('G2 X20 Y0 I10 J0 F600');
    const t = plan(arc.toolpath, cfg(), arc.sourceLines).totalSeconds;
    expect(t).toBeGreaterThan(3.14);
    expect(t).toBeLessThan(3.3);
  });

  it('per-line cumulative times', () => {
    const r = run('G0 X100\n(comment)\nG4 P1\nG0 X0');
    const p = plan(r.toolpath, cfg(), r.sourceLines);
    expect(p.lineEndTime[1]).toBeCloseTo(1.2, 3);
    expect(p.lineEndTime[2]).toBeCloseTo(1.2, 3);
    expect(p.lineEndTime[3]).toBeCloseTo(2.2, 3);
    expect(p.lineEndTime[4]).toBeCloseTo(p.totalSeconds);
  });
});

describe('stats', () => {
  it('bounds include arc bulges and report cut depth, feeds, tools', () => {
    const r = run('T1 M6\nG0 X10 Y0 Z5\nG1 Z-3 F200\nG3 X10 Y0 I-10 J0 F800\nG0 Z5\nT2 M6\nG1 Z-1 F100');
    plan(r.toolpath, cfg(), r.sourceLines);
    const s = computeStats(r.toolpath, [0, 0, 0, 0]);
    expect(s.cutBounds.min[0]).toBeCloseTo(-10, 1);
    expect(s.cutBounds.max[1]).toBeCloseTo(10, 1);
    expect(s.minCutZ).toBe(-3);
    expect(s.feedRange).toEqual([100, 800]);
    expect(s.tools.map((t) => t.tool)).toEqual([1, 2]);
    expect(s.distance.cut).toBeCloseTo(8 + 2 * Math.PI * 10 + 6, 1);
    expect(segStart(r.toolpath, 1)[2]).toBe(5);
  });

  it('analyze() works on a preset end to end', () => {
    const profile = profileFromPreset('generic-router');
    const res = analyze({ text: 'G21 G90\nM3 S10000\nG0 X10 Y10\nG1 Z-1 F300\nG1 X50\nG0 Z5\nM5\nM30', profile });
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(res.stats.time.total).toBeGreaterThan(0);
    expect(res.lineEndTime.length).toBe(9);
    expect(res.offsetsKnown).toBe(false);
  });
});
