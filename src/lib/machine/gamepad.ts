/**
 * Gamepad → jog intent (pure, unit tested). Standard mapping:
 *  - left stick: X / Y (proportional speed), right stick vertical: Z
 *  - D-pad: one jog step in X / Y; Y / △ button: step +Z, A / ✕: step −Z
 *  - nothing moves unless the enable button (LB by default) is held — the
 *    owner's "hold-to-enable" decision, so a bumped pad can't move the machine
 * The gamepad never starts jobs, zeroes or homes.
 */
export type Dir = [number, number, number];

export interface PadSnapshot {
  axes: readonly number[];
  buttons: readonly boolean[];
}

export interface StickIntent {
  /** Enable button held */
  enabled: boolean;
  /** Unit-length direction (or zeros) */
  dir: Dir;
  /** 0..1 deflection beyond the dead zone */
  magnitude: number;
}

/** Remove the dead zone and rescale so speed starts at 0 just outside it. */
export function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (!Number.isFinite(v) || a < dz) return 0;
  return (Math.sign(v) * Math.min(1, a - dz)) / (1 - dz);
}

export function stickIntent(p: PadSnapshot, opts: { enableButton: number; deadzone: number }): StickIntent {
  const enabled = !!p.buttons[opts.enableButton];
  const x = deadzone(p.axes[0] ?? 0, opts.deadzone);
  const y = -deadzone(p.axes[1] ?? 0, opts.deadzone); // stick up = +Y (away from you)
  const z = -deadzone(p.axes[3] ?? 0, opts.deadzone); // right stick up = +Z
  if (!enabled) return { enabled, dir: [0, 0, 0], magnitude: 0 };
  // Z on its own: mixing Z with X/Y from two sticks is rarely intended.
  if (Math.abs(z) > Math.max(Math.abs(x), Math.abs(y))) return { enabled, dir: [0, 0, Math.sign(z)], magnitude: Math.min(1, Math.abs(z)) };
  const m = Math.hypot(x, y);
  if (m === 0) return { enabled, dir: [0, 0, 0], magnitude: 0 };
  return { enabled, dir: [x / m, y / m, 0], magnitude: Math.min(1, m) };
}

const STEP_BUTTONS: Record<number, Dir> = {
  12: [0, 1, 0],
  13: [0, -1, 0],
  14: [-1, 0, 0],
  15: [1, 0, 0],
  3: [0, 0, 1],
  0: [0, 0, -1],
};

/** Step jogs for buttons that went down since the previous snapshot (only while enabled). */
export function stepPresses(prev: PadSnapshot | null, cur: PadSnapshot, enableButton: number): Dir[] {
  if (!cur.buttons[enableButton]) return [];
  const out: Dir[] = [];
  for (const [k, d] of Object.entries(STEP_BUTTONS)) {
    const i = Number(k);
    if (cur.buttons[i] && !prev?.buttons[i]) out.push(d);
  }
  return out;
}

/** Restart the jog when the direction turns more than ~8° or speed changes by >20 %. */
export function needsRestart(prev: { dir: Dir; magnitude: number } | null, cur: { dir: Dir; magnitude: number }): boolean {
  if (!prev) return true;
  const dot = prev.dir[0] * cur.dir[0] + prev.dir[1] * cur.dir[1] + prev.dir[2] * cur.dir[2];
  return dot < Math.cos((8 * Math.PI) / 180) || Math.abs(prev.magnitude - cur.magnitude) > 0.2;
}
