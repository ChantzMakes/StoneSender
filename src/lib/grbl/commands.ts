/**
 * Builders for the G-code the app itself sends (zeroing, go-to, park, WCS).
 * Values given to G10/G53 are interpreted in the controller's *current* modal
 * units, so we read G20/G21 from `$G` and convert — and never change the
 * modal units behind the user's back.
 */
import type { MachineProfile } from '@/lib/profile/schema';

export type Axis = 'X' | 'Y' | 'Z' | 'A';

export function modalInches(parserState: string[] | undefined): boolean {
  return parserState?.includes('G20') ?? false;
}

/** Format a mm value for the current modal units. */
export function modalValue(mm: number, inches: boolean): string {
  const v = inches ? mm / 25.4 : mm;
  return String(Number(v.toFixed(inches ? 4 : 3)));
}

/** Set the current position as work zero (current WCS, P0) for the given axes. */
export function zeroAxes(axes: Axis[]): string {
  return `G10 L20 P0 ${axes.map((a) => `${a}0`).join(' ')}`;
}

/** Raise Z to the profile's safe height in machine coordinates — never lower it. */
export function raiseToSafeZ(profile: MachineProfile, machineZ: number | undefined, inches: boolean): string[] {
  const safe = profile.safety.safeZMachine;
  if (machineZ !== undefined && machineZ >= safe - 1e-6) return [];
  return [`G53 G0 Z${modalValue(safe, inches)}`];
}

/** Rapid to work X0 Y0 at a safe height. */
export function goToXYZero(profile: MachineProfile, machineZ: number | undefined, inches: boolean): string[] {
  return [...raiseToSafeZ(profile, machineZ, inches), 'G90 G0 X0 Y0'];
}

export function goToZZero(): string[] {
  return ['G90 G0 Z0'];
}

/** Park: safe Z, then the park XY in machine coordinates. */
export function park(profile: MachineProfile, machineZ: number | undefined, inches: boolean): string[] {
  const p = profile.safety.parkPosition;
  return [...raiseToSafeZ(profile, machineZ, inches), `G53 G0 X${modalValue(p.x, inches)} Y${modalValue(p.y, inches)}`];
}

export const WCS_NAMES = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const;

/** Write offsets for G54..G59 (index 0..5) in mm. */
export function setWcsOffset(index: number, offset: Partial<Record<'x' | 'y' | 'z', number>>, inches: boolean): string {
  const words = (['x', 'y', 'z'] as const)
    .filter((a) => offset[a] !== undefined)
    .map((a) => `${a.toUpperCase()}${modalValue(offset[a]!, inches)}`)
    .join(' ');
  return `G10 L2 P${index + 1} ${words}`;
}

/** Step jog in mm (always G21 inside the jog — jog modes don't persist). */
export function stepJog(delta: { x?: number; y?: number; z?: number }, feedMmMin: number): string {
  const words = (['x', 'y', 'z'] as const)
    .filter((a) => delta[a])
    .map((a) => `${a.toUpperCase()}${Number(delta[a]!.toFixed(4))}`)
    .join(' ');
  return `$J=G91 G21 ${words} F${Math.round(feedMmMin)}`;
}
