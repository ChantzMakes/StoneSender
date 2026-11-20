/** `$$` settings metadata for GRBL 1.1 (grblHAL adds many more; unknown ids get a generic entry). */

export type SettingKind = 'int' | 'float' | 'bool' | 'mask';

export interface SettingMeta {
  id: number;
  name: string;
  unit: string;
  kind: SettingKind;
  description: string;
  min?: number;
  max?: number;
  group: 'Stepper' | 'Reporting' | 'Motion' | 'Limits & homing' | 'Spindle & laser' | 'Steps/mm' | 'Max rate' | 'Acceleration' | 'Max travel' | 'Other';
}

const axisRows = (base: number, group: SettingMeta['group'], what: string, unit: string, desc: string): SettingMeta[] =>
  ['X', 'Y', 'Z', 'A'].map((a, i) => ({ id: base + i, name: `${a} ${what}`, unit: a === 'A' ? unit.replace('mm', '°') : unit, kind: 'float', description: desc, min: 0, group }));

export const SETTINGS: SettingMeta[] = [
  { id: 0, name: 'Step pulse time', unit: 'µs', kind: 'int', min: 3, max: 255, group: 'Stepper', description: 'Length of each step pulse. 10 µs suits most drivers.' },
  { id: 1, name: 'Step idle delay', unit: 'ms', kind: 'int', min: 0, max: 255, group: 'Stepper', description: 'How long motors stay powered after a move. 255 keeps them always on (holds position; recommended for most routers).' },
  { id: 2, name: 'Step pulse invert', unit: 'mask', kind: 'mask', min: 0, max: 15, group: 'Stepper', description: 'Inverts step signals per axis. Rarely needed.' },
  { id: 3, name: 'Direction invert', unit: 'mask', kind: 'mask', min: 0, max: 15, group: 'Stepper', description: 'Reverses motor direction per axis (bit 0 = X, 1 = Y, 2 = Z). Use when an axis moves the wrong way.' },
  { id: 4, name: 'Invert step enable', unit: '', kind: 'bool', group: 'Stepper', description: 'Inverts the stepper enable pin.' },
  { id: 5, name: 'Invert limit pins', unit: '', kind: 'bool', group: 'Limits & homing', description: 'Use for normally-closed limit switches (or set by your board maker).' },
  { id: 6, name: 'Invert probe pin', unit: '', kind: 'bool', group: 'Limits & homing', description: 'Use for a normally-closed probe.' },
  { id: 10, name: 'Status report options', unit: 'mask', kind: 'mask', min: 0, max: 3, group: 'Reporting', description: 'Bit 0: report machine position (1) or work position (0). Bit 1: include buffer state. 1 is typical.' },
  { id: 11, name: 'Junction deviation', unit: 'mm', kind: 'float', min: 0, group: 'Motion', description: 'How much corners may be rounded to keep speed. 0.01 mm is typical.' },
  { id: 12, name: 'Arc tolerance', unit: 'mm', kind: 'float', min: 0, group: 'Motion', description: 'How finely arcs are split into straight segments. 0.002 mm is typical.' },
  { id: 13, name: 'Report in inches', unit: '', kind: 'bool', group: 'Reporting', description: 'Controller reports positions in inches. Leave off — this app converts units itself.' },
  { id: 20, name: 'Soft limits', unit: '', kind: 'bool', group: 'Limits & homing', description: 'Refuse moves outside the travel area. Requires homing ($22).' },
  { id: 21, name: 'Hard limits', unit: '', kind: 'bool', group: 'Limits & homing', description: 'Stop immediately when a limit switch triggers.' },
  { id: 22, name: 'Homing cycle', unit: '', kind: 'bool', group: 'Limits & homing', description: 'Enables $H homing. Needs limit switches.' },
  { id: 23, name: 'Homing direction invert', unit: 'mask', kind: 'mask', min: 0, max: 15, group: 'Limits & homing', description: 'Axes that home toward their negative end (bit 0 = X, 1 = Y, 2 = Z).' },
  { id: 24, name: 'Homing locate feed', unit: 'mm/min', kind: 'float', min: 0, group: 'Limits & homing', description: 'Slow speed used to touch the switch precisely.' },
  { id: 25, name: 'Homing search seek', unit: 'mm/min', kind: 'float', min: 0, group: 'Limits & homing', description: 'Fast speed used to find the switch.' },
  { id: 26, name: 'Homing debounce', unit: 'ms', kind: 'int', min: 0, max: 65535, group: 'Limits & homing', description: 'Delay to let switch contacts settle.' },
  { id: 27, name: 'Homing pull-off', unit: 'mm', kind: 'float', min: 0, group: 'Limits & homing', description: 'Distance to back off the switch after homing.' },
  { id: 30, name: 'Max spindle speed', unit: 'RPM / S', kind: 'float', min: 0, group: 'Spindle & laser', description: 'S value for full spindle speed / laser power.' },
  { id: 31, name: 'Min spindle speed', unit: 'RPM / S', kind: 'float', min: 0, group: 'Spindle & laser', description: 'S value for the lowest spindle speed.' },
  { id: 32, name: 'Laser mode', unit: '', kind: 'bool', group: 'Spindle & laser', description: 'ON for lasers (moves continuously through power changes, no power during rapids). Must be OFF for spindles.' },
  ...axisRows(100, 'Steps/mm', 'steps/mm', 'steps/mm', 'Motor steps for 1 mm of travel. Calibrate by measuring a long move.'),
  ...axisRows(110, 'Max rate', 'max rate', 'mm/min', 'Fastest speed for this axis (also used for rapids).'),
  ...axisRows(120, 'Acceleration', 'acceleration', 'mm/s²', 'How quickly the axis speeds up and slows down.'),
  ...axisRows(130, 'Max travel', 'max travel', 'mm', 'Usable travel; used by soft limits and homing.'),
];

const BY_ID = new Map(SETTINGS.map((s) => [s.id, s]));

export function settingMeta(id: number): SettingMeta {
  return BY_ID.get(id) ?? { id, name: `Setting $${id}`, unit: '', kind: 'float', group: 'Other', description: 'Controller-specific setting (see your firmware documentation).' };
}

export function validateSettingValue(id: number, text: string): string | null {
  const meta = settingMeta(id);
  const v = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(v)) return 'must be a number';
  if (v < 0) return 'must be 0 or more';
  if ((meta.kind === 'int' || meta.kind === 'mask' || meta.kind === 'bool') && !Number.isInteger(v)) return 'must be a whole number';
  if (meta.kind === 'bool' && v !== 0 && v !== 1) return 'must be 0 or 1';
  if (meta.min !== undefined && v < meta.min) return `must be at least ${meta.min}`;
  if (meta.max !== undefined && v > meta.max) return `must be at most ${meta.max}`;
  if (meta.group === 'Steps/mm' || meta.group === 'Max rate' || meta.group === 'Acceleration') {
    if (v <= 0) return 'must be greater than 0';
  }
  return null;
}

/** Format a value the way GRBL prints it. */
export function formatSettingValue(id: number, v: number): string {
  const k = settingMeta(id).kind;
  return k === 'float' ? v.toFixed(3) : String(Math.round(v));
}

export function sameSettingValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-3, Math.abs(b) * 1e-6);
}
