import { describe, expect, it } from 'vitest';
import { deadzone, needsRestart, stepPresses, stickIntent } from './gamepad';

const pad = (axes: number[], pressed: number[] = []) => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => pressed.includes(i)) });
const opts = { enableButton: 4, deadzone: 0.2 };

describe('gamepad jogging', () => {
  it('does nothing unless the enable button is held', () => {
    expect(stickIntent(pad([1, 0, 0, 0]), opts)).toEqual({ enabled: false, dir: [0, 0, 0], magnitude: 0 });
    expect(stepPresses(null, pad([0, 0, 0, 0], [15]), 4)).toEqual([]);
  });

  it('maps sticks with a dead zone; stick up = +Y, right stick up = +Z', () => {
    expect(deadzone(0.1, 0.2)).toBe(0);
    expect(deadzone(0.6, 0.2)).toBeCloseTo(0.5);
    const xy = stickIntent(pad([0.6, -0.6, 0, 0], [4]), opts);
    expect(xy.dir[0]).toBeCloseTo(Math.SQRT1_2);
    expect(xy.dir[1]).toBeCloseTo(Math.SQRT1_2);
    expect(xy.magnitude).toBeCloseTo(Math.hypot(0.5, 0.5));
    const z = stickIntent(pad([0.25, 0, 0, -0.9], [4]), opts);
    expect(z.dir).toEqual([0, 0, 1]);
    expect(z.magnitude).toBeCloseTo(0.875);
    expect(stickIntent(pad([0.1, 0.1, 0, 0.1], [4]), opts).magnitude).toBe(0);
  });

  it('step buttons fire once per press while enabled', () => {
    const a = pad([0, 0, 0, 0], [4, 15]);
    expect(stepPresses(null, a, 4)).toEqual([[1, 0, 0]]);
    expect(stepPresses(a, a, 4)).toEqual([]);
    expect(stepPresses(a, pad([0, 0, 0, 0], [4, 15, 0]), 4)).toEqual([[0, 0, -1]]);
  });

  it('restarts the jog only on a real change of direction or speed', () => {
    const a = { dir: [1, 0, 0] as [number, number, number], magnitude: 0.5 };
    expect(needsRestart(null, a)).toBe(true);
    expect(needsRestart(a, { dir: [Math.cos(0.05), Math.sin(0.05), 0], magnitude: 0.55 })).toBe(false);
    expect(needsRestart(a, { dir: [0, 1, 0], magnitude: 0.5 })).toBe(true);
    expect(needsRestart(a, { dir: [1, 0, 0], magnitude: 0.9 })).toBe(true);
  });
});
