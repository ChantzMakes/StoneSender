/**
 * Real-time override byte sequences. GRBL only supports relative steps
 * (±10 / ±1 %) and resets, so reaching a target value means sending a short
 * sequence computed from the current value reported in `Ov:`.
 */
export const OVR = {
  feed: { reset: 0x90, plus10: 0x91, minus10: 0x92, plus1: 0x93, minus1: 0x94, min: 10, max: 200 },
  spindle: { reset: 0x99, plus10: 0x9a, minus10: 0x9b, plus1: 0x9c, minus1: 0x9d, min: 10, max: 200 },
} as const;

export const RAPID = { 100: 0x95, 50: 0x96, 25: 0x97 } as const;

export function overrideBytes(kind: 'feed' | 'spindle', current: number, target: number): number[] {
  const t = OVR[kind];
  const goal = Math.max(t.min, Math.min(t.max, Math.round(target)));
  if (goal === 100) return current === 100 ? [] : [t.reset];
  // Starting from a reset is shorter when the goal is closer to 100.
  let from = current;
  const bytes: number[] = [];
  if (Math.abs(goal - 100) + 1 < Math.abs(goal - current)) {
    bytes.push(t.reset);
    from = 100;
  }
  let diff = goal - from;
  while (Math.abs(diff) >= 10) {
    bytes.push(diff > 0 ? t.plus10 : t.minus10);
    diff -= diff > 0 ? 10 : -10;
  }
  while (diff !== 0) {
    bytes.push(diff > 0 ? t.plus1 : t.minus1);
    diff -= diff > 0 ? 1 : -1;
  }
  return bytes;
}

export function rapidByte(target: 25 | 50 | 100): number {
  return RAPID[target];
}
