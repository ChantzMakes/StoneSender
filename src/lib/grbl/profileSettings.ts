/**
 * Profile ↔ controller `$$` mapping. Mirrors `MachineProfile::to_grbl_settings`
 * in Rust for the settings the profile owns. Used for the diff/sync screen and
 * the machine-type mismatch warnings.
 */
import { homingDirMask } from '@/lib/profile/geometry';
import { setPath } from '@/lib/profile/fields';
import type { HomeCorner, MachineProfile } from '@/lib/profile/schema';
import { sameSettingValue, settingMeta } from './settings';

/** Settings the profile describes, as GRBL expects them. */
export function expectedSettings(p: MachineProfile): Map<number, number> {
  const m = p.motion;
  const h = p.homing;
  const b = (v: boolean) => (v ? 1 : 0);
  const laserType = p.machineType === 'laser';
  const s = new Map<number, number>([
    [11, m.junctionDeviation],
    [12, m.arcTolerance],
    [20, b(h.softLimits)],
    [21, b(h.hardLimits)],
    [22, b(h.enabled)],
    [23, homingDirMask(p)],
    [24, h.feedRate],
    [25, h.seekRate],
    [27, h.pullOff],
    [30, laserType ? p.laser.maxPower : p.spindle.maxRpm],
    [31, laserType ? 0 : p.spindle.minRpm],
    [32, b(laserType || (p.machineType === 'router-laser' && p.laser.laserMode))],
    [100, m.stepsPerUnit.x],
    [101, m.stepsPerUnit.y],
    [102, m.stepsPerUnit.z],
    [110, m.maxRate.x],
    [111, m.maxRate.y],
    [112, m.maxRate.z],
    [120, m.acceleration.x],
    [121, m.acceleration.y],
    [122, m.acceleration.z],
    [130, p.geometry.envelope.x],
    [131, p.geometry.envelope.y],
    [132, p.geometry.envelope.z],
  ]);
  if (p.machineType === 'rotary' && p.rotary.mode === 'a-axis') {
    s.set(103, m.stepsPerUnit.a);
    s.set(113, m.maxRate.a);
    s.set(123, m.acceleration.a);
  }
  return s;
}

export interface SettingDiffRow {
  id: number;
  name: string;
  unit: string;
  profileValue: number;
  /** null when the controller did not report this setting */
  controllerValue: number | null;
  differs: boolean;
  /** Extra caveat shown next to the row */
  note?: string;
}

export function diffProfileWithController(p: MachineProfile, controller: Record<string, string>): SettingDiffRow[] {
  const rows: SettingDiffRow[] = [];
  const dirInvert = Number(controller['3'] ?? 0);
  for (const [id, pv] of expectedSettings(p)) {
    const raw = controller[String(id)];
    const cv = raw === undefined ? null : Number(raw);
    const meta = settingMeta(id);
    const row: SettingDiffRow = { id, name: meta.name, unit: meta.unit, profileValue: pv, controllerValue: cv, differs: cv === null ? false : !sameSettingValue(cv, pv) };
    if (id === 23 && dirInvert !== 0) row.note = `$3=${dirInvert} inverts some motor directions, so the home corner may not map directly to $23. Check homing on the machine.`;
    if (id === 30 || id === 31) row.note = p.machineType === 'laser' ? 'Laser: S value for full power' : undefined;
    rows.push(row);
  }
  return rows;
}

function cornerFromMask(mask: number): HomeCorner {
  const xNeg = (mask & 1) !== 0;
  const yNeg = (mask & 2) !== 0;
  return `${yNeg ? 'front' : 'back'}-${xNeg ? 'left' : 'right'}` as HomeCorner;
}

/** Copy the chosen controller values into the profile. */
export function applyControllerToProfile(p: MachineProfile, controller: Record<string, string>, ids: number[]): MachineProfile {
  let out = p;
  const laserType = p.machineType === 'laser';
  const num = (id: number) => Number(controller[String(id)]);
  const set = (path: string, v: unknown) => {
    out = setPath(out, path, v);
  };
  for (const id of ids) {
    if (controller[String(id)] === undefined) continue;
    const v = num(id);
    if (!Number.isFinite(v)) continue;
    switch (id) {
      case 11: set('motion.junctionDeviation', v); break;
      case 12: set('motion.arcTolerance', v); break;
      case 20: set('homing.softLimits', v !== 0); break;
      case 21: set('homing.hardLimits', v !== 0); break;
      case 22: set('homing.enabled', v !== 0); break;
      case 23:
        set('geometry.homeCorner', cornerFromMask(v));
        set('geometry.zHomeDirection', (v & 4) !== 0 ? 'down' : 'up');
        break;
      case 24: set('homing.feedRate', v); break;
      case 25: set('homing.seekRate', v); break;
      case 27: set('homing.pullOff', v); break;
      case 30: set(laserType ? 'laser.maxPower' : 'spindle.maxRpm', v); break;
      case 31: if (!laserType) set('spindle.minRpm', v); break;
      case 32: set('laser.laserMode', v !== 0); break;
      default: {
        const axis = ['x', 'y', 'z', 'a'][id % 10];
        const base = Math.floor(id / 10) * 10;
        const field = { 100: 'motion.stepsPerUnit', 110: 'motion.maxRate', 120: 'motion.acceleration', 130: 'geometry.envelope' }[base];
        if (field && axis && !(base === 130 && axis === 'a')) set(`${field}.${axis}`, v);
      }
    }
  }
  return out;
}

export interface MismatchWarning {
  severity: 'danger' | 'warning';
  message: string;
}

/** Spec §8: warn when the controller looks set up for a different machine type. */
export function machineTypeMismatch(p: MachineProfile, controller: Record<string, string>): MismatchWarning[] {
  const out: MismatchWarning[] = [];
  const laserMode = controller['32'];
  if (laserMode === undefined) return out;
  const on = Number(laserMode) !== 0;
  if (on && (p.machineType === 'router' || p.machineType === 'rotary')) {
    out.push({
      severity: 'danger',
      message: 'The controller has laser mode ON ($32=1) but your profile is a router. In laser mode GRBL does not wait for the spindle to spin up and keeps moving through speed changes. Turn laser mode off ($32=0) before cutting with a spindle.',
    });
  }
  if (!on && p.machineType === 'laser') {
    out.push({
      severity: 'warning',
      message: 'The controller has laser mode OFF ($32=0) but your profile is a laser. The beam will stay on during rapid moves and pause at every power change. Turn laser mode on ($32=1).',
    });
  }
  return out;
}
