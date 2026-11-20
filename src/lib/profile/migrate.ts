/**
 * Profile migration. Every stored or imported profile goes through
 * `migrateProfile` before use.
 *
 * To change the schema:
 *  1. bump SCHEMA_VERSION in schema.ts
 *  2. add `MIGRATIONS[oldVersion] = (p) => newShape` below
 *  3. update the Rust mirror + presets, add a test with an old-format fixture
 */
import { MachineProfileSchema, SCHEMA_VERSION, type MachineProfile, validateProfile } from './schema';
import { getPreset, newId } from './presets';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fill missing keys of `target` from `defaults` (recursively). Existing values win. */
export function fillDefaults(target: unknown, defaults: unknown): unknown {
  if (!isObject(defaults)) return target === undefined ? defaults : target;
  if (!isObject(target)) return structuredClone(defaults);
  const out: Json = { ...target };
  for (const [k, dv] of Object.entries(defaults)) {
    out[k] = k in target ? fillDefaults(target[k], dv) : structuredClone(dv);
  }
  return out;
}

/**
 * Migrations keyed by the version they upgrade *from*.
 * v0 = pre-release profiles without `schemaVersion` (and possibly missing
 * sections): fill everything missing from the generic router defaults.
 */
const MIGRATIONS: Record<number, (p: Json) => Json> = {
  0: (p) => {
    const base = structuredClone(getPreset('generic-router')!.profile) as unknown as Json;
    const filled = fillDefaults(p, base) as Json;
    return { ...filled, schemaVersion: 1 };
  },
};

export type MigrateResult =
  | { ok: true; profile: MachineProfile; migratedFrom: number | null; warnings: string[] }
  | { ok: false; errors: Record<string, string>; migratedFrom: number | null };

export function migrateProfile(raw: unknown): MigrateResult {
  if (!isObject(raw)) return { ok: false, errors: { '(profile)': 'not a profile object' }, migratedFrom: null };
  let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (!Number.isInteger(version) || version < 0) {
    return { ok: false, errors: { schemaVersion: 'invalid schema version' }, migratedFrom: null };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      errors: { schemaVersion: `this profile was made by a newer version of the app (schema ${version}); please update the app` },
      migratedFrom: null,
    };
  }
  const startVersion = version;
  let p: Json = structuredClone(raw);
  const warnings: string[] = [];
  while (version < SCHEMA_VERSION) {
    const m = MIGRATIONS[version];
    if (!m) return { ok: false, errors: { schemaVersion: `no migration from schema ${version}` }, migratedFrom: startVersion };
    p = m(p);
    version += 1;
  }
  if (startVersion !== SCHEMA_VERSION) {
    warnings.push(`Upgraded from profile format ${startVersion} to ${SCHEMA_VERSION}. Missing settings were filled with defaults — please review them.`);
    if (!p.id || typeof p.id !== 'string') p.id = newId();
    const now = new Date().toISOString();
    if (typeof p.createdAt !== 'string') p.createdAt = now;
    if (typeof p.updatedAt !== 'string') p.updatedAt = now;
  }
  const v = validateProfile(p);
  if (!v.ok) return { ok: false, errors: v.errors, migratedFrom: startVersion === SCHEMA_VERSION ? null : startVersion };
  return {
    ok: true,
    profile: MachineProfileSchema.parse(p),
    migratedFrom: startVersion === SCHEMA_VERSION ? null : startVersion,
    warnings,
  };
}
