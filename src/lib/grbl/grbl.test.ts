import { describe, expect, it } from 'vitest';
import type { JobScan, MachineStatus } from '@/lib/backend';
import { analyze } from '@/lib/gcode/analyze';
import { isBlocked, preflight } from '@/lib/job/preflight';
import { setPath } from '@/lib/profile/fields';
import { PRESETS, profileFromPreset } from '@/lib/profile/presets';
import { validateProfile } from '@/lib/profile/schema';
import { ALARMS, alarmInfo, ERRORS, errorInfo } from './codes';
import { overrideBytes, OVR } from './overrides';
import { applyControllerToProfile, diffProfileWithController, expectedSettings, machineTypeMismatch } from './profileSettings';
import { formatSettingValue, settingMeta, validateSettingValue } from './settings';

const toController = (m: Map<number, number>) => Object.fromEntries([...m].map(([k, v]) => [String(k), formatSettingValue(k, v)]));

describe('error and alarm tables', () => {
  it('covers every GRBL 1.1 code', () => {
    for (const c of [...Array.from({ length: 17 }, (_, i) => i + 1), ...Array.from({ length: 19 }, (_, i) => i + 20)]) expect(ERRORS[c], `error ${c}`).toBeDefined();
    for (let a = 1; a <= 9; a++) expect(ALARMS[a], `alarm ${a}`).toBeDefined();
    expect(errorInfo(22)!.title).toMatch(/feed/i);
    expect(alarmInfo(null)).toBeNull();
  });
});

describe('settings metadata', () => {
  it('validates values by kind', () => {
    expect(validateSettingValue(0, '2')).toMatch(/at least 3/);
    expect(validateSettingValue(32, '2')).toMatch(/0 or 1/);
    expect(validateSettingValue(110, '0')).toMatch(/greater than 0/);
    expect(validateSettingValue(110, 'abc')).toMatch(/number/);
    expect(validateSettingValue(110, '5000')).toBeNull();
    expect(settingMeta(999).group).toBe('Other');
    expect(formatSettingValue(22, 1)).toBe('1');
    expect(formatSettingValue(110, 500)).toBe('500.000');
  });
});

describe('profile ↔ controller', () => {
  it('matches the Rust mapping for presets', () => {
    // Values asserted by crates/grbl-core profile tests and the link round-trip test.
    expect(expectedSettings(profileFromPreset('x-carve')).get(23)).toBe(3);
    expect(expectedSettings(profileFromPreset('shapeoko')).get(23)).toBe(0);
    const laser = expectedSettings(profileFromPreset('generic-laser'));
    expect(laser.get(32)).toBe(1);
    expect(laser.get(30)).toBe(1000);
    expect(expectedSettings(profileFromPreset('generic-rotary')).has(103)).toBe(true);
  });

  it('a controller configured from the profile shows no differences', () => {
    for (const preset of PRESETS) {
      const p = profileFromPreset(preset.id);
      const rows = diffProfileWithController(p, toController(expectedSettings(p)));
      expect(rows.filter((r) => r.differs), preset.id).toEqual([]);
    }
  });

  it('detects differences and copies controller values into the profile', () => {
    const p = profileFromPreset('generic-router');
    const ctrl = toController(expectedSettings(p));
    ctrl['110'] = '1234.000';
    ctrl['23'] = '3';
    ctrl['32'] = '1';
    const diffs = diffProfileWithController(p, ctrl).filter((r) => r.differs).map((r) => r.id);
    expect(diffs.sort()).toEqual([110, 23, 32]);
    const updated = applyControllerToProfile(p, ctrl, [110, 23]);
    expect(updated.motion.maxRate.x).toBe(1234);
    expect(updated.geometry.homeCorner).toBe('front-left');
    expect(validateProfile(updated).ok).toBe(true);
    expect(diffProfileWithController(updated, ctrl).filter((r) => r.differs).map((r) => r.id)).toEqual([32]);
  });

  it('flags $23 as advisory when $3 inverts directions', () => {
    const p = profileFromPreset('generic-router');
    const ctrl = { ...toController(expectedSettings(p)), '3': '2' };
    expect(diffProfileWithController(p, ctrl).find((r) => r.id === 23)!.note).toMatch(/\$3=2/);
  });

  it('warns about laser mode on a router and off on a laser', () => {
    expect(machineTypeMismatch(profileFromPreset('generic-router'), { '32': '1' })[0]!.severity).toBe('danger');
    expect(machineTypeMismatch(profileFromPreset('generic-laser'), { '32': '0' })[0]!.severity).toBe('warning');
    expect(machineTypeMismatch(profileFromPreset('generic-laser'), { '32': '1' })).toEqual([]);
  });
});

describe('override byte sequences', () => {
  const apply = (start: number, bytes: number[], t = OVR.feed) =>
    bytes.reduce((v, b) => (b === t.reset ? 100 : b === t.plus10 ? v + 10 : b === t.minus10 ? v - 10 : b === t.plus1 ? v + 1 : v - 1), start);
  it('reaches every target from any start', () => {
    for (const start of [10, 55, 100, 137, 200]) {
      for (const target of [10, 42, 99, 100, 101, 150, 200]) {
        expect(apply(start, overrideBytes('feed', start, target)), `${start}→${target}`).toBe(target);
      }
    }
    expect(overrideBytes('feed', 100, 100)).toEqual([]);
    expect(overrideBytes('feed', 150, 100)).toEqual([OVR.feed.reset]);
    expect(apply(100, overrideBytes('feed', 100, 500))).toBe(200);
  });
});

describe('pre-flight', () => {
  const scan = (over: Partial<JobScan['features']> = {}, issues: JobScan['issues'] = []): JobScan => ({
    sourceLines: 10,
    lines: 10,
    bytes: 100,
    issues,
    issuesTruncated: 0,
    features: {
      unitsMm: true,
      unitsInch: false,
      spindleCw: true,
      spindleCcw: false,
      maxS: 10000,
      sChangesOnMoves: 0,
      toolChanges: [],
      tools: [],
      arcs: false,
      probe: false,
      coolantMist: false,
      coolantFlood: false,
      zWords: 10,
      aWords: 0,
      wcsUsed: ['G54'],
      programEnd: true,
      systemCommands: 0,
      dwellAfterSpindle: true,
      ...over,
    },
  });
  const idle = { state: { name: 'idle' }, wco: [-10, -10, -5] } as unknown as MachineStatus;
  const router = profileFromPreset('generic-router');
  // A small job cutting from X-10..10 work → well inside the envelope at WCO (-10,-10,-5).
  const job = (text: string) => ({ analysis: analyze({ text, profile: router }), analysisStatus: 'done' as const });
  const done = job('G21 G90\nG0 X-10 Y-10\nG1 Z-1 F300\nG1 X0');

  it('blocks while analysing, and on lines the interpreter rejects (run only)', () => {
    const running = preflight({ scan: scan(), profile: router, controller: null, status: idle, mode: 'run', analysis: null, analysisStatus: 'running' });
    expect(running.find((c) => c.id === 'analysis')?.level).toBe('block');
    const bad = job('G1 X5');
    expect(preflight({ scan: scan(), profile: router, controller: null, status: idle, mode: 'run', ...bad }).find((c) => c.id === 'interp')?.level).toBe('block');
    expect(preflight({ scan: scan(), profile: router, controller: null, status: idle, mode: 'check', ...bad }).find((c) => c.id === 'interp')?.level).toBe('info');
  });

  it('checks the job against the travel from the current work zero', () => {
    // Work zero near the right edge (X -10 of a 400 travel): X+20 goes 10 mm past.
    const tooFar = job('G21 G90\nG0 X20 Y-10\nG1 Z-1 F300');
    const nearEdge = { ...idle, wco: [-10, -100, -50] } as MachineStatus;
    const checks = preflight({ scan: scan(), profile: router, controller: null, status: nearEdge, mode: 'run', ...tooFar });
    const b = checks.find((c) => c.id === 'bounds')!;
    expect(b.level).toBe('block');
    expect(b.detail).toMatch(/X goes 10\.0 mm past the maximum/);
    const noHoming = setPath(router, 'homing.enabled', false);
    const nh = setPath(noHoming, 'homing.softLimits', false);
    expect(preflight({ scan: scan(), profile: nh, controller: null, status: nearEdge, mode: 'run', ...tooFar }).find((c) => c.id === 'bounds')!.level).toBe('warn');
    const fits = preflight({ scan: scan(), profile: router, controller: null, status: { ...idle, wco: [-200, -200, -50] } as MachineStatus, mode: 'run', ...tooFar });
    expect(fits.find((c) => c.id === 'bounds')!.level).toBe('ok');
    expect(fits.find((c) => c.id === 'depth')!.title).toMatch(/-1\.00 mm/);
  });

  it('passes a clean job', () => {
    const checks = preflight({ scan: scan(), profile: router, controller: null, status: idle, mode: 'run', ...done });
    expect(isBlocked(checks)).toBe(false);
  });

  it('blocks when not idle, on rejected lines, and on M6 without ignore', () => {
    expect(isBlocked(preflight({ scan: scan(), profile: router, controller: null, status: { ...idle, state: { name: 'alarm' } }, mode: 'run', ...done }))).toBe(true);
    expect(isBlocked(preflight({ scan: scan({}, [{ line: 3, severity: 'error', code: 'unsupported', message: 'G81' }]), profile: router, controller: null, status: idle, mode: 'run', ...done }))).toBe(true);
    const m6 = scan({ toolChanges: [{ line: 5, tool: 2 }] });
    // Phase 7: guided tool changes — M6 no longer blocks, unless the tool setter is chosen but not set up.
    expect(isBlocked(preflight({ scan: m6, profile: setPath(router, 'toolChange.strategy', 'pause'), controller: null, status: idle, mode: 'run', ...done }))).toBe(false);
    const noSetter = setPath(setPath(router, 'toolChange.strategy', 'tool-setter'), 'probe.toolSetter.enabled', false);
    expect(isBlocked(preflight({ scan: m6, profile: noSetter, controller: null, status: idle, mode: 'run', ...done }))).toBe(true);
    const ignore = setPath(router, 'toolChange.strategy', 'ignore');
    expect(isBlocked(preflight({ scan: m6, profile: ignore, controller: null, status: idle, mode: 'run', ...done }))).toBe(false);
  });

  it('blocks a router job when the controller is in laser mode', () => {
    const controller = { settings: { '32': '1' }, offsets: {}, parserState: [], build: { version: null, buildDate: null, options: null, plannerBlocks: null, rxBuffer: null, grblhal: false }, probe: null, rxBuffer: 128, charCounting: true };
    expect(isBlocked(preflight({ scan: scan(), profile: router, controller, status: idle, mode: 'run', ...done }))).toBe(true);
  });

  it('warns about laser-looking jobs on a router and missing units', () => {
    const laserish = scan({ spindleCw: false, spindleCcw: true, sChangesOnMoves: 500, zWords: 0, unitsMm: false });
    const ids = preflight({ scan: laserish, profile: router, controller: null, status: idle, mode: 'run', ...done }).filter((c) => c.level === 'warn').map((c) => c.id);
    expect(ids).toContain('laserjob');
    expect(ids).toContain('units');
  });

  it('warns when work zero was never set', () => {
    const z = { ...idle, wco: [0, 0, 0] } as MachineStatus;
    expect(preflight({ scan: scan(), profile: router, controller: null, status: z, mode: 'run', ...done }).some((c) => c.id === 'wcs' && c.level === 'warn')).toBe(true);
  });
});
