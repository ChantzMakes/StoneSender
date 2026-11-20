/** Display-unit conversion. Everything is stored in mm; inches are display only. */
import type { Units } from './schema';

export type UnitKind =
  | 'length'
  | 'feed'
  | 'accel'
  | 'stepsPerLength'
  | 'angle'
  | 'angleFeed'
  | 'angleAccel'
  | 'stepsPerAngle'
  | 'rpm'
  | 'sValue'
  | 'percent'
  | 'seconds'
  | 'hz'
  | 'baud'
  | 'bytes';

export const MM_PER_INCH = 25.4;

const LENGTH_LIKE: ReadonlySet<UnitKind> = new Set(['length', 'feed', 'accel']);

export function toDisplay(valueMm: number, kind: UnitKind, units: Units): number {
  if (units === 'inch') {
    if (LENGTH_LIKE.has(kind)) return valueMm / MM_PER_INCH;
    if (kind === 'stepsPerLength') return valueMm * MM_PER_INCH;
  }
  return valueMm;
}

export function fromDisplay(value: number, kind: UnitKind, units: Units): number {
  if (units === 'inch') {
    if (LENGTH_LIKE.has(kind)) return value * MM_PER_INCH;
    if (kind === 'stepsPerLength') return value / MM_PER_INCH;
  }
  return value;
}

export function unitLabel(kind: UnitKind, units: Units): string {
  const inch = units === 'inch';
  switch (kind) {
    case 'length':
      return inch ? 'in' : 'mm';
    case 'feed':
      return inch ? 'in/min' : 'mm/min';
    case 'accel':
      return inch ? 'in/s²' : 'mm/s²';
    case 'stepsPerLength':
      return inch ? 'steps/in' : 'steps/mm';
    case 'angle':
      return '°';
    case 'angleFeed':
      return '°/min';
    case 'angleAccel':
      return '°/s²';
    case 'stepsPerAngle':
      return 'steps/°';
    case 'rpm':
      return 'RPM';
    case 'sValue':
      return 'S';
    case 'percent':
      return '%';
    case 'seconds':
      return 's';
    case 'hz':
      return 'Hz';
    case 'baud':
      return 'baud';
    case 'bytes':
      return 'bytes';
  }
}

/** Sensible display precision per unit kind. */
export function decimals(kind: UnitKind, units: Units): number {
  if (kind === 'length') return units === 'inch' ? 4 : 3;
  if (kind === 'feed' || kind === 'accel') return units === 'inch' ? 2 : 1;
  if (kind === 'stepsPerLength' || kind === 'stepsPerAngle') return 3;
  if (kind === 'seconds' || kind === 'hz' || kind === 'percent') return 1;
  return 0;
}

/** Round for display without trailing noise (e.g. 15.748031496 → 15.748). */
export function roundForDisplay(v: number, kind: UnitKind, units: Units): number {
  const d = Math.max(decimals(kind, units), 0);
  const f = 10 ** (d + 1);
  return Math.round(v * f) / f;
}

export function formatLength(mm: number, units: Units, digits?: number): string {
  const v = toDisplay(mm, 'length', units);
  return v.toFixed(digits ?? decimals('length', units));
}
