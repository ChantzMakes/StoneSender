/**
 * Probing and tool-change routines (Phase 7): plain async functions over a
 * small machine interface, so they run against the real link (tracked
 * commands) and against the demo machine in unit tests.
 *
 * Conventions
 *  - Every step waits for the controller's `ok` before the next is sent.
 *  - Our own numbers are mm: routines switch to G21 and restore the
 *    controller's units and distance mode at the end (decision 17: never
 *    leave modal units changed behind the user's back).
 *  - Positions are found with G38.2 (error → ALARM:5 if nothing is touched);
 *    the fast touch is followed by a retract and a slow touch.
 *  - After a touch the machine is returned to the exact trigger point before
 *    an offset is written with G10 L20, so overshoot never enters the result.
 *  - Before any probing move the UI requires a touch test (probe pin seen).
 */
import type { MachineProfile } from '@/lib/profile/schema';

export type V3 = [number, number, number];

export interface MachineIO {
  /** Send a line and wait for ok (rejects on error / alarm / reset) */
  send(line: string): Promise<void>;
  /** Send a G38.x line and return the machine position of the touch */
  probe(line: string): Promise<{ position: V3 }>;
  /** Controller modal words from `$G` */
  parserState(): Promise<string[]>;
  /** Current work offset (machine position of work zero, mm) from the status reports */
  workOffset(): V3;
  /** Report what the routine is doing (UI) */
  step?(text: string): void;
}

const n = (v: number) => String(Number(v.toFixed(4)));

export interface ProbeSettings {
  fastFeed: number;
  slowFeed: number;
  retract: number;
  maxTravel: number;
}

export function probeSettings(p: MachineProfile): ProbeSettings {
  return { fastFeed: p.probe.fastFeed, slowFeed: p.probe.slowFeed, retract: Math.max(p.probe.retract, 0.5), maxTravel: p.probe.maxTravel };
}

/** Run `body` in mm / the controller's modes restored afterwards (also on failure, if still possible). */
async function withModes<T>(io: MachineIO, body: () => Promise<T>): Promise<T> {
  const words = await io.parserState();
  const restore = [words.includes('G20') ? 'G20' : 'G21', words.includes('G91') ? 'G91' : 'G90'].join(' ');
  await io.send('G21');
  try {
    return await body();
  } finally {
    // After an alarm the controller refuses commands; that is fine (reset restores defaults).
    await io.send(restore).catch(() => {});
  }
}

/**
 * Touch along one axis (fast, back off, slow) and return to the exact trigger
 * point. `dir` is +1 / −1. Returns the machine coordinate of the touch.
 */
export async function touch(io: MachineIO, axis: 'X' | 'Y' | 'Z', dir: 1 | -1, s: ProbeSettings, maxTravel = s.maxTravel): Promise<V3> {
  io.step?.(`Probing ${axis}${dir > 0 ? '+' : '−'}…`);
  await io.probe(`G91 G38.2 ${axis}${n(dir * maxTravel)} F${n(s.fastFeed)}`);
  await io.send(`G91 G0 ${axis}${n(-dir * s.retract)}`);
  const hit = await io.probe(`G91 G38.2 ${axis}${n(dir * (s.retract * 2 + 1))} F${n(s.slowFeed)}`);
  const p = hit.position;
  await io.send(`G90 G53 G0 X${n(p[0])} Y${n(p[1])} Z${n(p[2])}`);
  return p;
}

// ---------------------------------------------------------------------------
// Setting zero
// ---------------------------------------------------------------------------

/** Z touch plate on the stock: Z zero = plate surface − plate thickness. */
export async function probeZPlate(io: MachineIO, s: ProbeSettings, plateThickness: number): Promise<{ touchZ: number }> {
  return withModes(io, async () => {
    const p = await touch(io, 'Z', -1, s);
    await io.send(`G10 L20 P0 Z${n(plateThickness)}`);
    await io.send(`G91 G0 Z${n(s.retract + 2)}`);
    return { touchZ: p[2] };
  });
}

export interface CornerOptions {
  plateThickness: number;
  /** Plate wall thickness beside the stock edge */
  xyOffset: { x: number; y: number };
  toolDiameter: number;
  /** How far to move off the plate before dropping beside it */
  clearance: number;
}

/**
 * XYZ corner plate on the front-left corner of the stock. Start with the bit
 * above the plate's flat top. Sets X0 Y0 at the stock corner and Z0 on top.
 */
export async function probeCorner(io: MachineIO, s: ProbeSettings, o: CornerOptions): Promise<{ touch: V3 }> {
  return withModes(io, async () => {
    const r = o.toolDiameter / 2;
    const zTouch = await touch(io, 'Z', -1, s);
    await io.send(`G10 L20 P0 Z${n(o.plateThickness)}`);
    const up = s.retract + 2;
    const down = up + o.plateThickness / 2;
    const off = o.clearance + r;
    // X: off the left side, down beside the plate, touch moving right
    await io.send(`G91 G0 Z${n(up)}`);
    await io.send(`G91 G0 X${n(-off)}`);
    await io.send(`G91 G0 Z${n(-down)}`);
    const x = await touch(io, 'X', 1, s, off + s.retract + 5);
    await io.send(`G10 L20 P0 X${n(-(r + o.xyOffset.x))}`);
    await io.send(`G91 G0 X${n(-s.retract)}`);
    await io.send(`G91 G0 Z${n(down)}`);
    // Y: back over the plate, then off the front side
    await io.send(`G91 G0 X${n(off + s.retract)}`);
    await io.send(`G91 G0 Y${n(-off)}`);
    await io.send(`G91 G0 Z${n(-down)}`);
    const y = await touch(io, 'Y', 1, s, off + s.retract + 5);
    await io.send(`G10 L20 P0 Y${n(-(r + o.xyOffset.y))}`);
    await io.send(`G91 G0 Y${n(-s.retract)}`);
    await io.send(`G91 G0 Z${n(down)}`);
    return { touch: [x[0], y[1], zTouch[2]] };
  });
}

/**
 * Centre of a hole (inside) or of a round/square boss (outside). Inside: the
 * probe tip starts inside the hole below its rim. Outside: start above the
 * middle; `size` is the approximate width and `depth` how far to drop.
 * Sets X0 Y0 at the centre; returns the measured widths (probe tip diameter
 * included for inside, excluded for outside — the UI adds/subtracts it).
 */
export async function probeCenter(io: MachineIO, s: ProbeSettings, o: { mode: 'inside' | 'outside'; size: number; depth: number; toolDiameter: number }): Promise<{ center: [number, number]; width: [number, number] }> {
  return withModes(io, async () => {
    const r = o.toolDiameter / 2;
    const reach = o.size / 2 + 10;
    const res: number[] = [];
    for (const axis of ['X', 'Y'] as const) {
      const i = axis === 'X' ? 0 : 1;
      let a: V3;
      let b: V3;
      if (o.mode === 'inside') {
        a = await touch(io, axis, 1, s, reach);
        // still touching the wall: back off before probing the other side (else ALARM:4)
        await io.send(`G91 G0 ${axis}${n(-s.retract)}`);
        b = await touch(io, axis, -1, s, o.size + 10);
        await io.send(`G91 G0 ${axis}${n(s.retract)}`);
      } else {
        const off = o.size / 2 + r + 5;
        const lift = o.depth + s.retract + 2;
        await io.send(`G91 G0 Z${n(lift)}`);
        await io.send(`G91 G0 ${axis}${n(off)}`);
        await io.send(`G91 G0 Z${n(-lift)}`);
        a = await touch(io, axis, -1, s, off);
        await io.send(`G91 G0 ${axis}${n(s.retract)}`);
        await io.send(`G91 G0 Z${n(lift)}`);
        await io.send(`G91 G0 ${axis}${n(-(2 * off))}`);
        await io.send(`G91 G0 Z${n(-lift)}`);
        b = await touch(io, axis, 1, s, off);
        await io.send(`G91 G0 ${axis}${n(-s.retract)}`);
        await io.send(`G91 G0 Z${n(lift)}`);
      }
      const mid = (a[i]! + b[i]!) / 2;
      res.push(mid, Math.abs(a[i]! - b[i]!));
      await io.send(`G90 G53 G0 ${axis}${n(mid)}`);
    }
    await io.send('G10 L20 P0 X0 Y0');
    return {
      center: [res[0]!, res[2]!],
      width: o.mode === 'inside' ? [res[1]! + o.toolDiameter, res[3]! + o.toolDiameter] : [res[1]! - o.toolDiameter, res[3]! - o.toolDiameter],
    };
  });
}

// ---------------------------------------------------------------------------
// Tool setter and tool changes
// ---------------------------------------------------------------------------

/** Measure the fitted tool on the fixed tool setter: machine Z of the touch and the work Z it had there. */
export async function measureOnToolSetter(io: MachineIO, s: ProbeSettings, profile: MachineProfile): Promise<{ machineZ: number; workZ: number }> {
  const t = profile.probe.toolSetter.position;
  return withModes(io, async () => {
    io.step?.('Moving to the tool setter…');
    await io.send(`G53 G0 Z${n(profile.safety.safeZMachine)}`);
    await io.send(`G53 G0 X${n(t.x)} Y${n(t.y)}`);
    await io.send(`G53 G0 Z${n(t.z)}`);
    const p = await touch(io, 'Z', -1, s);
    const workZ = p[2] - io.workOffset()[2];
    await io.send(`G53 G0 Z${n(profile.safety.safeZMachine)}`);
    return { machineZ: p[2], workZ };
  });
}

/**
 * After measuring the old and new tool on the setter: shift work Z by the
 * length difference so Z0 stays on the same surface. Uses G10 L20 at a known
 * point: at machine Z `newTouch` the work Z must equal the work Z the old
 * tool had at `oldTouch`.
 */
export async function applyToolLengthChange(io: MachineIO, newTouchZ: number, oldWorkZAtTouch: number, profile: MachineProfile): Promise<void> {
  const t = profile.probe.toolSetter.position;
  await withModes(io, async () => {
    await io.send(`G53 G0 X${n(t.x)} Y${n(t.y)}`);
    await io.send(`G53 G0 Z${n(newTouchZ)}`);
    await io.send(`G10 L20 P0 Z${n(oldWorkZAtTouch)}`);
    await io.send(`G53 G0 Z${n(profile.safety.safeZMachine)}`);
  });
}

/** Spindle and coolant off, raise to safe Z, go to the tool-change position. */
export async function goToToolChange(io: MachineIO, profile: MachineProfile): Promise<void> {
  const c = profile.toolChange.position;
  await withModes(io, async () => {
    io.step?.('Stopping the spindle and moving to the tool-change position…');
    await io.send('M5');
    await io.send('M9');
    await io.send(`G53 G0 Z${n(profile.safety.safeZMachine)}`);
    await io.send(`G53 G0 X${n(c.x)} Y${n(c.y)}`);
    if (c.z < profile.safety.safeZMachine) await io.send(`G53 G0 Z${n(c.z)}`);
    // G4 P0 answers only once all motion has finished.
    await io.send('G4 P0');
  });
}

/** Back to safe Z and restore spindle / coolant the job had before the M6. */
export async function resumeAfterToolChange(io: MachineIO, profile: MachineProfile, spindle: { cmd: 'M3' | 'M4' | 'M5'; speed: number }, coolant: { flood: boolean; mist: boolean }): Promise<void> {
  await withModes(io, async () => {
    io.step?.('Raising to safe Z and restarting the spindle…');
    await io.send(`G53 G0 Z${n(profile.safety.safeZMachine)}`);
    if (coolant.flood) await io.send('M8');
    if (coolant.mist) await io.send('M7');
    if (spindle.cmd !== 'M5' && spindle.speed > 0) {
      await io.send(`${spindle.cmd} S${n(spindle.speed)}`);
      if (profile.spindle.spinUpDelaySec > 0) await io.send(`G4 P${n(profile.spindle.spinUpDelaySec)}`);
    }
    await io.send('G4 P0');
  });
}

// ---------------------------------------------------------------------------
// Height map
// ---------------------------------------------------------------------------

export interface GridSpec {
  /** Work coordinates of the area (mm) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  nx: number;
  ny: number;
  /** Work Z to travel at between points */
  clearance: number;
  /** How far below Z0 to search before giving up (alarm) */
  depth: number;
}

/**
 * Probe a grid (serpentine order) and return the surface work Z at each point,
 * row-major. Z0 must already be set on the surface. Ends at the clearance height.
 */
export async function probeHeightMap(io: MachineIO, s: ProbeSettings, g: GridSpec, onPoint?: (done: number, total: number, z: number) => void): Promise<{ x0: number; y0: number; dx: number; dy: number; nx: number; ny: number; z: number[] }> {
  const dx = g.nx > 1 ? (g.x1 - g.x0) / (g.nx - 1) : 0;
  const dy = g.ny > 1 ? (g.y1 - g.y0) / (g.ny - 1) : 0;
  const z = new Array<number>(g.nx * g.ny).fill(0);
  return withModes(io, async () => {
    await io.send(`G90 G0 Z${n(g.clearance)}`);
    let done = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let k = 0; k < g.nx; k++) {
        const i = j % 2 === 0 ? k : g.nx - 1 - k;
        const x = g.x0 + dx * i;
        const y = g.y0 + dy * j;
        io.step?.(`Point ${done + 1} of ${g.nx * g.ny}`);
        await io.send(`G90 G0 X${n(x)} Y${n(y)}`);
        const hit = await touch(io, 'Z', -1, s, g.clearance + g.depth);
        const wz = hit[2] - io.workOffset()[2];
        z[j * g.nx + i] = wz;
        onPoint?.(++done, g.nx * g.ny, wz);
        await io.send(`G90 G0 Z${n(g.clearance)}`);
      }
    }
    return { x0: g.x0, y0: g.y0, dx: dx || 1, dy: dy || 1, nx: g.nx, ny: g.ny, z };
  });
}
