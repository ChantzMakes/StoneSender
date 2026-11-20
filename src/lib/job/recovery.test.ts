import { describe, expect, it } from 'vitest';
import { interpret, splitLines, stateBeforeLine } from '@/lib/gcode/interpreter';
import { profileFromPreset } from '@/lib/profile/presets';
import { buildRecovery } from './recovery';

const router = profileFromPreset('generic-router');

function recover(text: string, line: number, profile = router, laserMode = false) {
  const r = interpret(text, { checkpointEvery: 2 });
  const state = stateBeforeLine(text, r, line);
  return buildRecovery({ line, state, lines: splitLines(text), profile, laserMode });
}

describe('start from line', () => {
  const job = ['G21 G90 G17', 'T1', 'M3 S12000', 'G0 Z5', 'G0 X10 Y10', 'G1 Z-2 F300', 'G1 X50 F1200', 'G1 Y40', 'G1 X10', 'G0 Z5', 'M5', 'M30'].join('\n');

  it('restores modes, retracts, spins up, approaches and plunges', () => {
    const r = recover(job, 8);
    expect(r.blockers).toEqual([]);
    expect(r.start.slice(0, 3)).toEqual([50, 10, -2]);
    expect(r.prelude).toEqual([
      'G21 G90 G17 G94',
      'G54',
      `G53 G0 Z${router.safety.safeZMachine}`,
      'T1',
      'M3 S12000',
      ...(router.spindle.spinUpDelaySec > 0 ? [`G4 P${router.spindle.spinUpDelaySec}`] : []),
      'G0 X50 Y10',
      `G0 Z${-2 + router.safety.clearanceZ}`,
      `G1 Z-2 F${Math.min(1200, router.motion.maxRate.z)}`,
      'G21 G90 F1200 G1',
    ]);
  });

  it('keeps inch jobs in inches after its own mm moves', () => {
    const inch = ['G20 G90', 'M3 S10000', 'G0 X1 Y1 Z0.2', 'G1 Z-0.1 F10', 'G1 X2 F40', 'G1 Y2'].join('\n');
    const r = recover(inch, 6);
    expect(r.start[0]).toBeCloseTo(50.8);
    expect(r.prelude[0]).toBe('G21 G90 G17 G94');
    expect(r.prelude.at(-1)).toBe('G20 G90 F40 G1');
  });

  it("plunges at the job's own plunge feed when known", () => {
    const r = buildRecovery({ line: 8, state: stateBeforeLine(job, interpret(job), 8), lines: splitLines(job), profile: router, laserMode: false, plungeFeed: 300 });
    expect(r.prelude).toContain('G1 Z-2 F300');
  });

  it('blocks when skipped lines set position-dependent state', () => {
    const r = recover(['G21', 'G92 X0 Y0', 'G1 X10 F100', 'G1 X20'].join('\n'), 4);
    expect(r.blockers[0]).toContain('G92');
    const p = recover(['G21', 'G38.2 Z-10 F50', 'G10 L20 P0 Z0', 'G1 X20 F100'].join('\n'), 4);
    expect(p.blockers.join(' ')).toContain('G38');
  });

  it('refuses to start in the middle of a modal arc', () => {
    const r = recover(['G21 G90', 'G0 X0 Y0', 'G1 F300', 'G2 X10 Y0 I5 J0', 'X0 Y0 I-5 J0'].join('\n'), 5);
    expect(r.blockers.join(' ')).toContain('arc');
  });

  it('warns about the tool fitted after a tool change', () => {
    const r = recover(['G21', 'T1 M6', 'M3 S10000', 'G1 X5 F200', 'T2 M6', 'M3 S10000', 'G1 X10 F200', 'G1 X20'].join('\n'), 8);
    expect(r.warnings.join(' ')).toContain('T2');
  });

  it('lasers: no plunge, laser restored only after positioning', () => {
    const laser = profileFromPreset('generic-laser');
    const r = recover(['G21 G90', 'M4 S0', 'G0 X5 Y5', 'G1 X20 S600 F2000', 'G1 Y20', 'M5'].join('\n'), 5, laser, true);
    const i = r.prelude.findIndex((l) => l.startsWith('M4'));
    expect(i).toBeGreaterThan(r.prelude.findIndex((l) => l.startsWith('G0 X20')));
    expect(r.prelude.some((l) => l.startsWith('G4'))).toBe(false);
    expect(r.prelude.some((l) => l.startsWith('G1 Z'))).toBe(false);
  });
});
