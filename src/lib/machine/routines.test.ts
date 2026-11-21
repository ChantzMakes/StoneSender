import { describe, expect, it } from 'vitest';
import { DemoMachine, type SolidBox } from '@/lib/backend/demoMachine';
import { profileFromPreset } from '@/lib/profile/presets';
import { applyToolLengthChange, goToToolChange, measureOnToolSetter, probeCenter, probeCorner, probeZPlate, type MachineIO, type ProbeSettings, type V3 } from './routines';

const S: ProbeSettings = { fastFeed: 200, slowFeed: 25, retract: 2, maxTravel: 50 };

function io(m: DemoMachine): MachineIO {
  const run = (line: string) => {
    const r = m.exec(line);
    const last = r.at(-1)!;
    if (last !== 'ok') throw new Error(`${line} → ${last}`);
    return r;
  };
  return {
    async send(line) {
      run(line);
    },
    async probe(line) {
      const r = run(line);
      const prb = /\[PRB:([-\d.,]+):1\]/.exec(r.join(' '));
      if (!prb) throw new Error('no touch');
      return { position: prb[1]!.split(',').map(Number) as V3 };
    },
    async parserState() {
      return m.parserState();
    },
    workOffset: () => m.wco,
  };
}

function machine(solids: SolidBox[], at: V3): DemoMachine {
  const m = new DemoMachine();
  m.solids = solids;
  m.pos = [...at];
  return m;
}

const stock = (x0: number, y0: number, top: number): SolidBox => ({ min: [x0, y0, -200], max: [0, 0, top] });

describe('probing routines', () => {
  it('Z plate: work Z0 on the stock under the plate, units restored', async () => {
    const m = machine([stock(-300, -300, -60), { min: [-150, -150, -60], max: [-100, -100, -50] }], [-120, -120, -20]);
    m.inches = true;
    const r = await probeZPlate(io(m), S, 10);
    expect(r.touchZ).toBeCloseTo(-50);
    expect(m.wco[2]).toBeCloseTo(-60);
    expect(m.inches).toBe(true);
    expect(m.pos[2]).toBeGreaterThan(-50);
  });

  it('XYZ corner plate: X0 Y0 at the stock corner, Z0 on top', async () => {
    const x0 = -200;
    const y0 = -150;
    // The demo probe is a point: widen the plate by the bit radius (3 mm) to model a Ø6 bit's edge touching.
    const m = machine([stock(x0, y0, -60), { min: [x0 - 5 - 3, y0 - 5 - 3, -60], max: [x0 + 50, y0 + 50, -50] }], [x0 + 10, y0 + 10, -30]);
    await probeCorner(io(m), S, { plateThickness: 10, xyOffset: { x: 5, y: 5 }, toolDiameter: 6, clearance: 20 });
    expect(m.wco[0]).toBeCloseTo(x0, 3);
    expect(m.wco[1]).toBeCloseTo(y0, 3);
    expect(m.wco[2]).toBeCloseTo(-60, 3);
    expect(m.relative).toBe(false);
  });

  it('finds the centre of a hole', async () => {
    const [cx, cy, r] = [-100, -80, 12];
    const ring: SolidBox[] = [
      { min: [cx - 60, cy - 60, -100], max: [cx - r, cy + 60, -40] },
      { min: [cx + r, cy - 60, -100], max: [cx + 60, cy + 60, -40] },
      { min: [cx - 60, cy - 60, -100], max: [cx + 60, cy - r, -40] },
      { min: [cx - 60, cy + r, -100], max: [cx + 60, cy + 60, -40] },
    ];
    const m = machine(ring, [cx + 3, cy - 4, -50]);
    // point probe: measured width + probe diameter (2) — so the hole reads 2 mm wider than the point model
    const res = await probeCenter(io(m), S, { mode: 'inside', size: 24, depth: 0, toolDiameter: 2 });
    expect(res.center[0]).toBeCloseTo(cx, 3);
    expect(res.center[1]).toBeCloseTo(cy, 3);
    expect(res.width[0]).toBeCloseTo(2 * r + 2, 3);
    expect(m.wco[0]).toBeCloseTo(cx, 3);
  });

  it('tool setter: a longer bit keeps Z0 on the same surface', async () => {
    const profile = profileFromPreset('generic-router');
    profile.probe.toolSetter = { enabled: true, position: { x: -20, y: -20, z: -50 } };
    const setter = (top: number): SolidBox => ({ min: [-25, -25, -200], max: [-15, -15, top] });
    const m = machine([setter(-80)], [-100, -100, -10]);
    m.wcs[0] = [-150, -150, -60];
    const before = await measureOnToolSetter(io(m), S, profile);
    expect(before.machineZ).toBeCloseTo(-80);
    expect(before.workZ).toBeCloseTo(-20);
    // New bit sticks out 5 mm further: it touches 5 mm higher.
    m.solids = [setter(-75)];
    const after = await measureOnToolSetter(io(m), S, profile);
    await applyToolLengthChange(io(m), after.machineZ, before.workZ, profile);
    expect(m.wco[2]).toBeCloseTo(-55);
  });

  it('a probe that touches nothing raises the alarm and stops', async () => {
    const m = machine([], [0, 0, 0]);
    await expect(probeZPlate(io(m), S, 10)).rejects.toThrow('ALARM:5');
    expect(m.alarm).toBe(5);
    expect(m.log.some((l) => l.startsWith('G10'))).toBe(false);
  });

  it('tool change: spindle off, safe Z first, then the change position', async () => {
    const profile = profileFromPreset('generic-router');
    const m = machine([], [-100, -100, -60]);
    await goToToolChange(io(m), profile);
    const i = m.log.findIndex((l) => l.startsWith('G53G0Z'));
    expect(m.log.indexOf('M5')).toBeLessThan(i);
    expect(m.log[i + 1]).toMatch(/^G53G0X/);
    expect(m.pos[0]).toBeCloseTo(profile.toolChange.position.x);
  });
});

describe('height map probing', () => {
  it('probes a grid in serpentine order and returns work heights', async () => {
    const { probeHeightMap } = await import('./routines');
    // a stock surface stepped by 0.5 mm in the right half (machine top -60 / -59.5)
    const m = machine([{ min: [-300, -300, -200], max: [-100, 0, -60] }, { min: [-100, -300, -200], max: [0, 0, -59.5] }], [-150, -150, -50]);
    m.wcs[0] = [-200, -200, -60];
    const seen: number[] = [];
    const h = await probeHeightMap(io(m), S, { x0: 0, y0: 0, x1: 150, y1: 50, nx: 4, ny: 2, clearance: 3, depth: 5 }, (_d, _t, z) => seen.push(z));
    expect(seen).toHaveLength(8);
    expect(h.dx).toBeCloseTo(50);
    // work X 0/50 → machine −200/−150 (low part), 100/150 → −100/−50 (raised part)
    expect(h.z.slice(0, 4).map((v) => Number(v.toFixed(3)))).toEqual([0, 0, 0.5, 0.5]);
    expect(m.workPos[2]).toBeCloseTo(3);
  });
});

describe('laser framing', () => {
  it('traces the job bounds; laser only with M4 in laser mode', async () => {
    const { frameJob } = await import('./routines');
    const laser = profileFromPreset('generic-laser');
    laser.laser.framingPowerPercent = 1;
    const m = machine([], [0, 0, 0]);
    await frameJob(io(m), { min: [10, 20, 0], max: [60, 50, 0] }, laser, true);
    const moves = m.log.filter((l) => l.startsWith('G1'));
    expect(moves).toHaveLength(4);
    expect(m.log).toContain(`M4S${Math.round(laser.laser.maxPower / 100)}`);
    expect(m.log.at(-3)).toBe('M5');
    expect(m.workPos.slice(0, 2)).toEqual([10, 20]);
    await expect(frameJob(io(new DemoMachine()), { min: [0, 0, 0], max: [1, 1, 0] }, laser, false)).rejects.toThrow('laser mode');
    laser.laser.framingPowerPercent = 0;
    const off = machine([], [0, 0, 0]);
    await frameJob(io(off), { min: [0, 0, 0], max: [5, 5, 0] }, laser, false);
    expect(off.log.some((l) => l.startsWith('M4') || l.startsWith('M3'))).toBe(false);
  });
});
