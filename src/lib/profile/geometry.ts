/**
 * Geometry helpers derived from a profile. Mirrors `MachineProfile::machine_bounds`
 * and `homes_negative` in Rust (GRBL 1.1 `limits_go_home` conventions).
 */
import type { MachineProfile } from './schema';

export interface Bounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** Does each axis home toward its minimum end? Assumes $3 leaves axes un-inverted (+X right, +Y back, +Z up). */
export function homesNegative(p: MachineProfile): { x: boolean; y: boolean; z: boolean } {
  const c = p.geometry.homeCorner;
  return { x: c.endsWith('left'), y: c.startsWith('front'), z: p.geometry.zHomeDirection === 'down' };
}

export function machineBounds(p: MachineProfile): Bounds {
  const e = p.geometry.envelope;
  const neg = homesNegative(p);
  const axis = (travel: number, homesNeg: boolean): [number, number] => {
    if (p.geometry.coordinateMode === 'negative-space') return [-travel, 0];
    return homesNeg ? [0, travel] : [-travel, 0];
  };
  const [xmin, xmax] = axis(e.x, neg.x);
  const [ymin, ymax] = axis(e.y, neg.y);
  const [zmin, zmax] = axis(e.z, neg.z);
  return { min: { x: xmin, y: ymin, z: zmin }, max: { x: xmax, y: ymax, z: zmax } };
}

/** Machine position of the home switches (before pull-off). */
export function homePosition(p: MachineProfile): { x: number; y: number; z: number } {
  const b = machineBounds(p);
  const neg = homesNegative(p);
  return { x: neg.x ? b.min.x : b.max.x, y: neg.y ? b.min.y : b.max.y, z: neg.z ? b.min.z : b.max.z };
}

/** `$23` homing direction invert mask implied by the home corner. */
export function homingDirMask(p: MachineProfile): number {
  const n = homesNegative(p);
  return (n.x ? 1 : 0) | (n.y ? 2 : 0) | (n.z ? 4 : 0);
}

export function isLaserLike(p: MachineProfile): boolean {
  return p.machineType === 'laser';
}

export function hasSpindle(p: MachineProfile): boolean {
  return p.machineType !== 'laser';
}

export function hasLaser(p: MachineProfile): boolean {
  return p.machineType === 'laser' || p.machineType === 'router-laser';
}

export function hasRotary(p: MachineProfile): boolean {
  return p.machineType === 'rotary';
}

/** Axis letters the DRO should show. */
export function axesFor(p: MachineProfile): ('X' | 'Y' | 'Z' | 'A')[] {
  return hasRotary(p) && p.rotary.mode === 'a-axis' ? ['X', 'Y', 'Z', 'A'] : ['X', 'Y', 'Z'];
}
