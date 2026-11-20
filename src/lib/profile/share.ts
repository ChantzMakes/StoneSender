/**
 * Import / export of profiles as shareable JSON files, plus the review
 * summary shown before an imported profile is added.
 *
 * Safety: importing never touches the controller. Writing `$$` values from a
 * profile happens only through the settings sync screen (Phase 2), which asks
 * for confirmation of every individual change.
 */
import { migrateProfile } from './migrate';
import { newId } from './presets';
import type { MachineProfile } from './schema';
import { formatLength } from './units';

export const EXPORT_FORMAT = 'cnc-sender-profile';
export const EXPORT_FORMAT_VERSION = 1;

export interface ProfileExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  app: string;
  profile: MachineProfile;
}

export function exportProfile(p: MachineProfile, appVersion = '0.1.0'): string {
  const file: ProfileExportFile = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    app: `CNC Sender ${appVersion}`,
    profile: p,
  };
  return JSON.stringify(file, null, 2);
}

export function exportFileName(p: MachineProfile): string {
  const slug = p.identity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'machine';
  return `${slug}.cncprofile.json`;
}

export type ImportResult =
  | { ok: true; profile: MachineProfile; warnings: string[]; facts: { label: string; value: string }[] }
  | { ok: false; errors: Record<string, string> };

/**
 * Parse an imported file (export wrapper or bare profile), migrate, validate
 * and assign a fresh id so it can never overwrite an existing profile.
 */
export function parseProfileImport(text: string, existingNames: string[] = []): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: { '(file)': `not valid JSON: ${(e as Error).message}` } };
  }
  let raw: unknown = data;
  if (typeof data === 'object' && data !== null && (data as { format?: unknown }).format === EXPORT_FORMAT) {
    const f = data as Partial<ProfileExportFile>;
    if (typeof f.formatVersion === 'number' && f.formatVersion > EXPORT_FORMAT_VERSION) {
      return { ok: false, errors: { '(file)': 'this file was exported by a newer version of the app; please update' } };
    }
    raw = f.profile;
  }
  const m = migrateProfile(raw);
  if (!m.ok) return { ok: false, errors: m.errors };
  const now = new Date().toISOString();
  const profile: MachineProfile = { ...m.profile, id: newId(), createdAt: now, updatedAt: now };
  if (existingNames.includes(profile.identity.name)) {
    profile.identity = { ...profile.identity, name: `${profile.identity.name} (imported)`.slice(0, 60) };
  }
  return { ok: true, profile, warnings: [...m.warnings, ...reviewWarnings(profile)], facts: describeProfile(profile) };
}

const TYPE_LABEL: Record<MachineProfile['machineType'], string> = {
  router: '3-axis router / mill',
  laser: 'Laser',
  'router-laser': 'Router + laser',
  rotary: '4-axis rotary',
};

export function describeProfile(p: MachineProfile): { label: string; value: string }[] {
  const e = p.geometry.envelope;
  const u = p.units;
  const unit = u === 'inch' ? 'in' : 'mm';
  return [
    { label: 'Name', value: p.identity.name },
    { label: 'Type', value: TYPE_LABEL[p.machineType] },
    { label: 'Work area', value: `${formatLength(e.x, u, 1)} × ${formatLength(e.y, u, 1)} × ${formatLength(e.z, u, 1)} ${unit}` },
    { label: 'Home corner', value: `${p.geometry.homeCorner.replace('-', ' ')}, Z ${p.geometry.zHomeDirection}` },
    { label: 'Homing', value: p.homing.enabled ? `on${p.homing.softLimits ? ', soft limits on' : ''}` : 'off' },
    { label: 'Controller', value: `${p.controller.firmware === 'auto' ? 'auto-detect' : p.controller.firmware}, ${p.controller.baudRate} baud` },
    p.machineType === 'laser'
      ? { label: 'Laser', value: `S max ${p.laser.maxPower}, laser mode ${p.laser.laserMode ? 'on' : 'off'}` }
      : { label: 'Spindle', value: `${p.spindle.type}, ${p.spindle.minRpm}–${p.spindle.maxRpm} RPM` },
    { label: 'Steps/mm', value: `X ${p.motion.stepsPerUnit.x}, Y ${p.motion.stepsPerUnit.y}, Z ${p.motion.stepsPerUnit.z}` },
  ];
}

/** Things worth a second look before using a profile someone else made. */
export function reviewWarnings(p: MachineProfile): string[] {
  const w: string[] = [];
  const e = p.geometry.envelope;
  if (p.machineType !== 'laser' && p.machineType !== 'router-laser' && p.laser.laserMode) {
    w.push('Laser mode is on but this is not a laser profile. With laser mode on, GRBL does not wait for a spindle to spin up — dangerous for routers.');
  }
  if (p.machineType === 'laser' && !p.laser.laserMode) {
    w.push('This is a laser profile but laser mode ($32) is off. The beam will stay on during rapid moves and pause at every power change.');
  }
  if (Math.max(e.x, e.y) > 3000 || e.z > 500) {
    w.push('The work area is unusually large. Double-check the travel values match your machine.');
  }
  if (p.homing.softLimits && !p.homing.enabled) {
    w.push('Soft limits are on without homing.');
  }
  if (p.laser.airAssist === 'M7' && (p.machineType === 'laser' || p.machineType === 'router-laser')) {
    w.push('Air assist uses M7, which stock GRBL 1.1 rejects (error:20). Use M8 unless your controller runs grblHAL or a custom build.');
  }
  if (p.machineType !== 'laser' && p.spindle.spinUpDelaySec < 1 && p.spindle.type !== 'pwm') {
    w.push('Spin-up delay is under 1 second. Most routers need 3–5 seconds to reach speed before cutting.');
  }
  if (p.controller.statusPollHz > 15) {
    w.push('Status polling above 15 Hz adds serial traffic with little benefit.');
  }
  return w;
}
