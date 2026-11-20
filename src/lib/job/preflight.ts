/**
 * Pre-flight checks shown (and confirmed) before every job — spec §8.
 *
 * Phase 2 covers what can be judged from a word-level scan plus the profile
 * and controller state. Bounds vs envelope, rapids through stock etc. need the
 * full interpreter and arrive in Phases 3–5 (listed as "not yet checked").
 */
import type { ControllerInfo, JobScan, MachineStatus } from '@/lib/backend';
import { machineTypeMismatch } from '@/lib/grbl/profileSettings';
import type { AnalysisResult } from '@/lib/gcode/client';
import { machineBounds } from '@/lib/profile/geometry';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength } from '@/lib/profile/units';

export type CheckLevel = 'block' | 'warn' | 'ok' | 'info';

export interface PreflightCheck {
  id: string;
  level: CheckLevel;
  title: string;
  detail?: string;
}

export interface PreflightInput {
  scan: JobScan;
  profile: MachineProfile;
  controller: ControllerInfo | null;
  status: MachineStatus | null;
  mode: 'run' | 'check';
  /** Interpreter/planner analysis of the job (null while it runs) */
  analysis?: AnalysisResult | null;
  analysisStatus?: 'idle' | 'running' | 'done' | 'error';
}

export function preflight({ scan, profile, controller, status, mode, analysis, analysisStatus }: PreflightInput): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  const f = scan.features;
  const add = (c: PreflightCheck) => out.push(c);
  const laserProfile = profile.machineType === 'laser';
  const routerProfile = profile.machineType === 'router' || profile.machineType === 'rotary';

  // --- controller state
  const st = status?.state?.name;
  if (st !== 'idle') add({ id: 'state', level: 'block', title: 'Machine must be Idle', detail: st ? `It is currently ${st}.` : 'No status from the controller yet.' });
  else add({ id: 'state', level: 'ok', title: 'Machine is idle' });

  // --- lines the controller would reject
  const errors = scan.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    add({
      id: 'unsupported',
      level: 'block',
      title: `${errors.length + (scan.issuesTruncated || 0)} line(s) the controller would reject`,
      detail: errors
        .slice(0, 5)
        .map((i) => `Line ${i.line}: ${i.message}`)
        .join('\n'),
    });
  } else add({ id: 'unsupported', level: 'ok', title: 'Every line is supported by the controller' });
  for (const w of scan.issues.filter((i) => i.severity === 'warning').slice(0, 5)) add({ id: `w${w.line}`, level: 'warn', title: `Line ${w.line}`, detail: w.message });

  // --- tool changes (handled in Phase 7)
  if (f.toolChanges.length && mode === 'run') {
    if (profile.toolChange.strategy === 'ignore') {
      add({ id: 'm6', level: 'warn', title: `${f.toolChanges.length} tool change(s) will be ignored`, detail: 'Your profile is set to ignore M6. The whole job runs with the bit that is in the spindle now.' });
    } else {
      add({
        id: 'm6',
        level: 'block',
        title: `${f.toolChanges.length} tool change(s) (M6)`,
        detail: 'Guided tool changes arrive in a later update. For now, split the job into one file per tool (most CAM can do this), or set the profile’s tool change setting to “Ignore M6”.',
      });
    }
  }

  // --- units
  if (f.unitsMm && f.unitsInch) add({ id: 'units', level: 'info', title: 'Job switches between mm (G21) and inches (G20)', detail: 'That is fine if intended; check your CAM post processor.' });
  else if (!f.unitsMm && !f.unitsInch) add({ id: 'units', level: 'warn', title: 'Job does not say mm or inches', detail: 'With no G20/G21 the controller keeps whatever units were used last. Most CAM adds G21 — check the file came from a GRBL post processor.' });
  else add({ id: 'units', level: 'ok', title: `Units: ${f.unitsMm ? 'millimetres (G21)' : 'inches (G20)'}` });

  // --- spindle / laser
  const powerOn = f.spindleCw || f.spindleCcw;
  if (laserProfile) {
    if (!powerOn) add({ id: 'power', level: 'warn', title: 'Laser is never switched on', detail: 'No M3/M4 found — nothing will burn.' });
    else if (f.spindleCw && !f.spindleCcw && profile.laser.defaultM4Dynamic) add({ id: 'power', level: 'info', title: 'Job uses M3 (constant power)', detail: 'Your profile prefers M4 dynamic power; corners may burn darker with M3.' });
    else add({ id: 'power', level: 'ok', title: 'Laser on/off commands present' });
    if (f.maxS > profile.laser.maxPower) add({ id: 'smax', level: 'warn', title: `S up to ${f.maxS} but full power is S${profile.laser.maxPower}`, detail: 'Values above $30 are clamped to full power.' });
  } else {
    if (!powerOn) {
      add({
        id: 'power',
        level: profile.spindle.type === 'router' ? 'info' : 'warn',
        title: 'Spindle is never switched on (no M3/M4)',
        detail: profile.spindle.type === 'router' ? 'Fine if you switch your router on by hand — make sure it is running before you start.' : 'The bit would plunge without spinning.',
      });
    } else add({ id: 'power', level: 'ok', title: 'Spindle on/off commands present' });
    if (powerOn && !f.dwellAfterSpindle && profile.spindle.spinUpDelaySec > 0) {
      add({ id: 'spinup', level: 'info', title: 'No pause after the spindle starts', detail: `Your profile asks for ${profile.spindle.spinUpDelaySec} s of spin-up. Automatic insertion arrives with the G-code engine; add a G4 P${profile.spindle.spinUpDelaySec} in CAM if your spindle needs it.` });
    }
    if (profile.spindle.type !== 'router' && f.maxS > profile.spindle.maxRpm) add({ id: 'smax', level: 'warn', title: `Spindle speed up to S${f.maxS}, profile maximum is ${profile.spindle.maxRpm}` });
  }

  // --- job looks like it was made for a different machine type (§8)
  if (routerProfile && f.spindleCcw && f.sChangesOnMoves > 10 && f.zWords === 0) {
    add({ id: 'laserjob', level: 'warn', title: 'This looks like a laser job', detail: 'It uses M4 and changes power on almost every move, with no Z moves — but the active profile is a router.' });
  }
  if (laserProfile && f.zWords > 20 && !powerOn) {
    add({ id: 'routerjob', level: 'warn', title: 'This looks like a router job', detail: 'Lots of Z moves and no laser commands, but the active profile is a laser.' });
  }
  if (f.coolantMist && profile.machineType !== 'laser') add({ id: 'm7', level: 'info', title: 'Job turns on mist coolant (M7)' });

  // --- controller configuration vs profile
  if (controller) {
    for (const m of machineTypeMismatch(profile, controller.settings)) add({ id: `mm-${m.message.slice(0, 8)}`, level: m.severity === 'danger' ? 'block' : 'warn', title: m.severity === 'danger' ? 'Controller is in laser mode' : 'Controller laser mode is off', detail: m.message });
  }

  // --- work coordinates
  const wco = status?.wco ?? [];
  if (mode === 'run' && wco.length >= 3 && wco.every((v) => Math.abs(v) < 1e-6)) {
    add({ id: 'wcs', level: 'warn', title: 'Work zero is the same as machine zero', detail: 'Have you set your work zero (X/Y/Z) on the stock? If not, zero the axes first.' });
  }
  if (f.wcsUsed.length > 1 || (f.wcsUsed.length === 1 && f.wcsUsed[0] !== 'G54')) {
    add({ id: 'wcs-used', level: 'info', title: `Job uses ${f.wcsUsed.join(', ')}`, detail: 'Make sure those work offsets are set (Work offsets dialog).' });
  }
  if (f.probe) add({ id: 'probe', level: 'warn', title: 'Job contains probing moves (G38)', detail: 'Make sure the probe is connected and positioned.' });

  // --- interpreter + bounds (needs the analysis)
  if (analysisStatus === 'running' || (analysisStatus !== 'error' && !analysis)) {
    add({ id: 'analysis', level: 'block', title: 'Still analysing the job…', detail: 'Wait a moment — bounds and time are being calculated.' });
  } else if (analysisStatus === 'error' || !analysis) {
    add({ id: 'analysis', level: 'warn', title: 'The job could not be analysed', detail: 'Bounds could not be checked. Check the job fits your machine.' });
  } else {
    for (const c of analysisChecks(analysis, profile, status, mode)) add(c);
  }
  add({ id: 'sim', level: 'info', title: 'Not yet checked: plunges below the stock and rapids through it', detail: 'These come with the stock simulator. Check your CAM settings.' });
  return out;
}

export function isBlocked(checks: PreflightCheck[]): boolean {
  return checks.some((c) => c.level === 'block');
}

/** Checks that need the interpreter / planner result. */
export function analysisChecks(a: AnalysisResult, profile: MachineProfile, status: MachineStatus | null, mode: 'run' | 'check'): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  const units = profile.units;
  const u = units === 'inch' ? 'in' : 'mm';
  const errs = a.diagnostics.filter((d) => d.severity === 'error');
  if (errs.length) {
    out.push({
      id: 'interp',
      level: mode === 'run' ? 'block' : 'info',
      title: `${errs.length + a.diagnosticsTruncated} line(s) the controller will reject${mode === 'check' ? ' — a check run will confirm' : ''}`,
      detail: errs
        .slice(0, 5)
        .map((d) => `Line ${d.line}: ${d.message}${d.code ? ` (error:${d.code})` : ''}`)
        .join('\n'),
    });
  }
  const st = a.stats;
  if (st.cutBounds.empty && st.workBounds.empty) {
    out.push({ id: 'empty', level: 'warn', title: 'The job does not move the machine' });
    return out;
  }
  // Job bounds in machine coordinates = work bounds + live work offset.
  const wco = status?.wco ?? [];
  const env = machineBounds(profile);
  if (wco.length >= 3 && mode === 'run') {
    const axes = ['X', 'Y', 'Z'] as const;
    const over: string[] = [];
    const keys = ['x', 'y', 'z'] as const;
    for (let i = 0; i < 3; i++) {
      const lo = st.workBounds.min[i]! + wco[i]!;
      const hi = st.workBounds.max[i]! + wco[i]!;
      const k = keys[i]!;
      if (lo < env.min[k] - 0.01) over.push(`${axes[i]} goes ${formatLength(env.min[k] - lo, units, 1)} ${u} past the ${i === 2 ? 'bottom' : 'minimum'}`);
      if (hi > env.max[k] + 0.01) over.push(`${axes[i]} goes ${formatLength(hi - env.max[k], units, 1)} ${u} past the ${i === 2 ? 'top' : 'maximum'}`);
    }
    if (over.length) {
      out.push({
        id: 'bounds',
        level: profile.homing.enabled ? 'block' : 'warn',
        title: 'The job does not fit inside the machine travel from this work zero',
        detail:
          over.join('\n') +
          (profile.homing.enabled
            ? '\nMove the work zero or check the job.'
            : '\nYour machine has no homing, so its idea of the travel limits may be off — but check the job really fits.'),
      });
    } else {
      out.push({ id: 'bounds', level: 'ok', title: 'The job fits inside the machine travel' });
    }
    if (a.usesMachineCoords || a.changesOffsets) {
      out.push({ id: 'bounds-approx', level: 'info', title: 'Travel check is approximate', detail: 'The job uses G53/G28/G30 or changes work offsets (G10/G92/G54…), which depend on what is stored in the controller.' });
    }
  }
  const size = (i: number) => formatLength(st.cutBounds.max[i]! - st.cutBounds.min[i]!, units, 1);
  if (!st.cutBounds.empty) {
    out.push({ id: 'size', level: 'info', title: `Cutting area ${size(0)} × ${size(1)} ${u}, from X${formatLength(st.cutBounds.min[0]!, units, 1)} Y${formatLength(st.cutBounds.min[1]!, units, 1)}` });
  }
  if (st.minCutZ !== null && profile.machineType !== 'laser') {
    out.push({ id: 'depth', level: 'info', title: `Deepest cut: Z ${formatLength(st.minCutZ, units, 2)} ${u}`, detail: 'Measured from your Z zero. Make sure the stock (and spoilboard) can take it.' });
  }
  const maxRate = Math.min(profile.motion.maxRate.x, profile.motion.maxRate.y);
  if (st.feedRange && st.feedRange[1] > maxRate * 1.001) {
    out.push({ id: 'feedmax', level: 'info', title: `Feed up to ${Math.round(st.feedRange[1])} mm/min is above the machine maximum (${Math.round(maxRate)})`, detail: 'The controller limits it to the maximum, so the job will take longer than CAM says.' });
  }
  return out;
}
