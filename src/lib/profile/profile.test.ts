import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_GROUPS, getPath, setPath, visibleGroups } from './fields';
import { homesNegative, homingDirMask, machineBounds } from './geometry';
import { fillDefaults, migrateProfile } from './migrate';
import { getPreset, PRESETS, profileFromPreset } from './presets';
import { MachineProfileSchema, SCHEMA_VERSION, validateProfile } from './schema';
import { exportProfile, parseProfileImport, reviewWarnings } from './share';
import { fromDisplay, MM_PER_INCH, toDisplay, unitLabel } from './units';

describe('presets', () => {
  it('ships all required presets and every one validates', () => {
    const ids = PRESETS.map((p) => p.id);
    for (const required of ['generic-router', 'generic-laser', 'desktop-3018', 'shapeoko', 'x-carve', 'longmill', 'onefinity']) {
      expect(ids).toContain(required);
    }
    for (const p of PRESETS) expect(validateProfile(p.profile).ok, p.id).toBe(true);
  });

  it('laser preset has laser mode on; routers have it off', () => {
    expect(getPreset('generic-laser')!.profile.laser.laserMode).toBe(true);
    for (const p of PRESETS.filter((x) => x.machineType === 'router')) expect(p.profile.laser.laserMode, p.id).toBe(false);
  });

  it('profileFromPreset makes an independent copy with a new id', () => {
    const a = profileFromPreset('shapeoko');
    const b = profileFromPreset('shapeoko');
    expect(a.id).not.toBe(b.id);
    expect(a.identity.presetId).toBe('shapeoko');
    a.geometry.envelope.x = 1;
    expect(getPreset('shapeoko')!.profile.geometry.envelope.x).not.toBe(1);
  });
});

describe('schema validation', () => {
  const base = () => profileFromPreset('generic-router');

  it('rejects unknown keys and bad values with dotted paths', () => {
    const p = { ...base(), surprise: 1 };
    expect(validateProfile(p).ok).toBe(false);
    const bad = setPath(base(), 'geometry.envelope.x', -10);
    const r = validateProfile(bad);
    expect(r.ok).toBe(false);
    expect(r.errors['geometry.envelope.x']).toMatch(/greater than 0/);
  });

  it('enforces cross-field rules', () => {
    let p = setPath(base(), 'spindle.minRpm', 40000);
    expect(validateProfile(p).errors['spindle.minRpm']).toBeTruthy();
    p = setPath(setPath(base(), 'homing.enabled', false), 'homing.softLimits', true);
    expect(validateProfile(p).errors['homing.softLimits']).toMatch(/homing/);
  });

  it('requires a name and a valid id', () => {
    expect(validateProfile(setPath(base(), 'identity.name', '  ')).errors['identity.name']).toBeTruthy();
    expect(validateProfile(setPath(base(), 'id', '../x')).errors.id).toBeTruthy();
  });
});

describe('migration', () => {
  it('passes current-version profiles through untouched', () => {
    const p = profileFromPreset('generic-laser');
    const r = migrateProfile(p);
    expect(r.ok && r.migratedFrom === null && r.profile).toEqual(p);
  });

  it('upgrades a legacy (v0) profile, filling missing sections', () => {
    const legacy = { identity: { name: 'Old one', notes: '', icon: null, presetId: null }, units: 'inch', machineType: 'router', geometry: { envelope: { x: 500, y: 500, z: 90 } } };
    const r = migrateProfile(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(0);
    expect(r.profile.schemaVersion).toBe(SCHEMA_VERSION);
    expect(r.profile.geometry.envelope.x).toBe(500);
    expect(r.profile.units).toBe('inch');
    expect(r.profile.motion.maxRate.x).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/Upgraded/);
  });

  it('refuses profiles from a newer app version', () => {
    const r = migrateProfile({ ...profileFromPreset('generic-router'), schemaVersion: SCHEMA_VERSION + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.schemaVersion).toMatch(/newer version/);
  });

  it('fillDefaults keeps existing values', () => {
    expect(fillDefaults({ a: 1, b: { c: 2 } }, { a: 9, b: { c: 9, d: 3 }, e: 4 })).toEqual({ a: 1, b: { c: 2, d: 3 }, e: 4 });
  });
});

describe('units', () => {
  it('stores mm and converts for display', () => {
    expect(toDisplay(25.4, 'length', 'inch')).toBeCloseTo(1);
    expect(fromDisplay(1, 'length', 'inch')).toBeCloseTo(25.4);
    expect(toDisplay(2540, 'feed', 'inch')).toBeCloseTo(100);
    expect(toDisplay(80, 'stepsPerLength', 'inch')).toBeCloseTo(80 * MM_PER_INCH);
    expect(toDisplay(100, 'rpm', 'inch')).toBe(100);
    expect(toDisplay(5, 'angle', 'inch')).toBe(5);
    expect(unitLabel('feed', 'mm')).toBe('mm/min');
    expect(unitLabel('feed', 'inch')).toBe('in/min');
  });

  it('round-trips through display units', () => {
    for (const v of [0.01, 1, 123.456, 9999]) expect(fromDisplay(toDisplay(v, 'length', 'inch'), 'length', 'inch')).toBeCloseTo(v, 9);
  });
});

describe('geometry', () => {
  it('derives the $23 mask from the home corner', () => {
    const p = profileFromPreset('generic-router');
    expect(homingDirMask({ ...p, geometry: { ...p.geometry, homeCorner: 'back-right', zHomeDirection: 'up' } })).toBe(0);
    expect(homingDirMask({ ...p, geometry: { ...p.geometry, homeCorner: 'front-left', zHomeDirection: 'up' } })).toBe(3);
    expect(homingDirMask({ ...p, geometry: { ...p.geometry, homeCorner: 'front-right', zHomeDirection: 'down' } })).toBe(6);
    expect(homesNegative({ ...p, geometry: { ...p.geometry, homeCorner: 'back-left' } })).toMatchObject({ x: true, y: false });
  });

  it('computes machine bounds per coordinate mode (matches Rust)', () => {
    const p = profileFromPreset('generic-router');
    const neg = machineBounds({ ...p, geometry: { ...p.geometry, coordinateMode: 'negative-space', homeCorner: 'front-left' } });
    expect(neg.min.x).toBe(-p.geometry.envelope.x);
    expect(neg.max).toEqual({ x: 0, y: 0, z: 0 });
    const pos = machineBounds({ ...p, geometry: { ...p.geometry, coordinateMode: 'positive-space', homeCorner: 'front-left' } });
    expect(pos.min.x).toBe(0);
    expect(pos.max.x).toBe(p.geometry.envelope.x);
    expect(pos.min.z).toBe(-p.geometry.envelope.z);
  });
});

describe('import / export', () => {
  it('round-trips a profile through the export file with a fresh id', () => {
    const p = profileFromPreset('longmill', 'Shop mill');
    const r = parseProfileImport(exportProfile(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile.id).not.toBe(p.id);
    expect({ ...r.profile, id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt }).toEqual(p);
  });

  it('accepts a bare profile and renames on a name clash', () => {
    const p = profileFromPreset('generic-router', 'Garage');
    const r = parseProfileImport(JSON.stringify(p), ['Garage']);
    expect(r.ok && r.profile.identity.name).toBe('Garage (imported)');
  });

  it('imports every sample profile in samples/profiles', () => {
    const dir = path.resolve(__dirname, '../../../samples/profiles');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = parseProfileImport(readFileSync(path.join(dir, f), 'utf8'));
      expect(r.ok, f).toBe(true);
    }
  });

  it('reports invalid JSON and invalid profiles without throwing', () => {
    expect(parseProfileImport('{nope').ok).toBe(false);
    const bad = parseProfileImport(JSON.stringify(setPath(profileFromPreset('generic-router'), 'controller.baudRate', 7)));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors['controller.baudRate']).toBeTruthy();
  });

  it('warns about laser mode on a router and M7 air assist', () => {
    const p = setPath(profileFromPreset('generic-router'), 'laser.laserMode', true);
    expect(reviewWarnings(p).join(' ')).toMatch(/Laser mode is on/);
    const l = setPath(profileFromPreset('generic-laser'), 'laser.airAssist', 'M7');
    expect(reviewWarnings(l).join(' ')).toMatch(/M7/);
  });
});

describe('field metadata', () => {
  it('every field path exists in the schema', () => {
    const p = profileFromPreset('generic-rotary');
    for (const g of FIELD_GROUPS) {
      for (const f of g.fields) {
        expect(getPath(p, f.path), f.path).not.toBeUndefined();
      }
    }
  });

  it('every schema leaf is editable or shown somewhere (except bookkeeping)', () => {
    const p = profileFromPreset('generic-rotary');
    const covered = new Set(FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.path)));
    const skip = new Set(['schemaVersion', 'id', 'createdAt', 'updatedAt', 'identity.presetId']);
    const leaves: string[] = [];
    const walk = (o: unknown, prefix: string) => {
      if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, prefix ? `${prefix}.${k}` : k);
      else leaves.push(prefix);
    };
    walk(p, '');
    const missing = leaves.filter((l) => !skip.has(l) && !covered.has(l));
    expect(missing).toEqual([]);
  });

  it('hides laser settings for routers and spindle settings for lasers', () => {
    const router = visibleGroups(profileFromPreset('generic-router')).map((g) => g.id);
    const laser = visibleGroups(profileFromPreset('generic-laser')).map((g) => g.id);
    expect(router).not.toContain('laser');
    expect(router).toContain('spindle');
    expect(laser).toContain('laser');
    expect(laser).not.toContain('spindle');
  });

  it('setPath is immutable', () => {
    const p = profileFromPreset('generic-router');
    const q = setPath(p, 'geometry.envelope.x', 123);
    expect(p.geometry.envelope.x).not.toBe(123);
    expect(q.geometry.envelope.x).toBe(123);
    expect(q.motion).toBe(p.motion);
    expect(MachineProfileSchema.safeParse(q).success).toBe(true);
  });
});
