/**
 * Built-in presets. The JSON files in `/presets` are shared with the Rust
 * tests, so they are always valid against both schemas.
 */
import type { MachineProfile, MachineType } from './schema';
import { MachineProfileSchema } from './schema';

const files = import.meta.glob<MachineProfile>('../../../presets/*.json', { eager: true, import: 'default' });

export interface PresetInfo {
  id: string;
  name: string;
  blurb: string;
  machineType: MachineType;
  profile: MachineProfile;
}

/** Display order and short descriptions for the wizard. */
const ORDER: { id: string; blurb: string }[] = [
  { id: 'generic-router', blurb: 'A neutral mid-size hobby router. Good if your machine is not listed.' },
  { id: 'generic-laser', blurb: 'Open-frame diode laser engraver with GRBL laser mode.' },
  { id: 'desktop-3018', blurb: 'Small 3018-style desktop mill. Usually no homing switches.' },
  { id: 'shapeoko', blurb: 'Carbide 3D Shapeoko 3 (Standard), belt-drive Z.' },
  { id: 'x-carve', blurb: 'Inventables X-Carve 1000 mm.' },
  { id: 'longmill', blurb: 'Sienci LongMill MK2 30×30.' },
  { id: 'onefinity', blurb: 'Onefinity Machinist frame on a GRBL/grblHAL controller.' },
  { id: 'generic-rotary', blurb: 'Router with a true 4th (A) axis rotary.' },
];

function load(): PresetInfo[] {
  const byId = new Map<string, MachineProfile>();
  for (const [path, raw] of Object.entries(files)) {
    const id = path.split('/').pop()!.replace(/\.json$/, '');
    // Presets are validated by tests; parse here anyway so a bad edit fails loudly.
    byId.set(id, MachineProfileSchema.parse(raw));
  }
  return ORDER.filter((o) => byId.has(o.id)).map((o) => {
    const profile = byId.get(o.id)!;
    return { id: o.id, name: profile.identity.name, blurb: o.blurb, machineType: profile.machineType, profile };
  });
}

export const PRESETS: PresetInfo[] = load();

export function getPreset(id: string): PresetInfo | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh, editable profile cloned from a preset (new id and timestamps). */
export function profileFromPreset(presetId: string, name?: string): MachineProfile {
  const preset = getPreset(presetId) ?? PRESETS[0]!;
  const now = new Date().toISOString();
  const p = structuredClone(preset.profile);
  p.id = newId();
  p.createdAt = now;
  p.updatedAt = now;
  p.identity.presetId = preset.id;
  p.identity.name = name ?? `My ${preset.name}`.slice(0, 60);
  return p;
}

/** Fallback defaults: the generic router preset. */
export function defaultProfile(): MachineProfile {
  return profileFromPreset('generic-router', 'My machine');
}
