/**
 * Start from line N (spec §5): the recovery lines that bring the controller
 * into the state the job expects at line N, and the reasons it can't.
 *
 * Order (all of our own moves in mm / absolute, the job's modes last):
 *  1. G21 G90, plane, feed mode, WCS
 *  2. raise to the profile's safe Z in machine coordinates
 *  3. tool number, coolant, spindle on + spin-up dwell (routers)
 *  4. rapid to X Y (A) of the start point
 *  5. routers: rapid down to clearance above the start Z, then feed down
 *     lasers: spindle / laser state restored only now (G0 never fires)
 *  6. the job's units, distance mode and feed; G0/G1 motion mode
 *
 * Position-dependent state the skipped lines set up (G92, G10, G43.1, G28.1,
 * G30.1, probing) can't be reproduced safely: those block the start.
 */
import { tokenize, type InterpState } from '@/lib/gcode/interpreter';
import { segStartPoint } from '@/lib/gcode/render';
import { SEG, type Toolpath } from '@/lib/gcode/toolpath';
import type { MachineProfile } from '@/lib/profile/schema';

export interface RecoveryInput {
  /** 1-based line to start at */
  line: number;
  /** Interpreter state just before that line (analysis frame: work = machine) */
  state: InterpState;
  /** Raw text of all source lines (to scan the skipped part and the start line) */
  lines: string[];
  profile: MachineProfile;
  /** Controller is in laser mode ($32=1) */
  laserMode: boolean;
  /** Feed of the job's last plunge before the line (mm/min), if any */
  plungeFeed?: number | null;
}

export interface Recovery {
  prelude: string[];
  /** Start point in work coordinates (mm) */
  start: [number, number, number, number];
  tool: number;
  spindleOn: boolean;
  blockers: string[];
  warnings: string[];
}

const fmt = (v: number, inches = false) => String(Number((inches ? v / 25.4 : v).toFixed(inches ? 4 : 3)));

/** Lines before `line` that leave state behind we can't replay. */
function scanSkipped(lines: string[], line: number): { blockers: string[]; lastToolChange: number | null } {
  const blockers: string[] = [];
  let lastToolChange: number | null = null;
  const seen = new Set<string>();
  for (let i = 1; i < line && i <= lines.length; i++) {
    const { words } = tokenize(lines[i - 1]!);
    for (const w of words) {
      let what: string | null = null;
      if (w.letter === 'G') {
        const g = Math.round(w.value * 10);
        if (g === 920) what = 'G92 (temporary offset)';
        else if (g === 100) what = 'G10 (writes work offsets)';
        else if (g === 431) what = 'G43.1 (tool length offset)';
        else if (g === 281 || g === 301) what = `G${w.value} (stores a position)`;
        else if (g >= 382 && g <= 385) what = 'G38 probing';
      } else if (w.letter === 'M' && Math.round(w.value) === 6) lastToolChange = i;
      if (what && !seen.has(what)) {
        seen.add(what);
        blockers.push(`Line ${i} uses ${what}. The app can't reproduce that when skipping lines — start from the beginning, or remove it from the file.`);
      }
    }
  }
  return { blockers, lastToolChange };
}

export function buildRecovery({ line, state, lines, profile, laserMode, plungeFeed }: RecoveryInput): Recovery {
  const m = state.modal;
  const laser = profile.machineType === 'laser' || laserMode;
  const { blockers, lastToolChange } = scanSkipped(lines, line);
  const warnings: string[] = [];
  const start = [...state.pos] as [number, number, number, number];
  const spindleOn = m.spindle !== 'M5' && m.speed > 0;

  // The start line itself
  const startText = lines[line - 1] ?? '';
  const { words } = tokenize(startText);
  const motionWord = words.some((w) => w.letter === 'G' && [0, 1, 2, 3].includes(Math.round(w.value * 10) / 10));
  const axisWords = words.some((w) => 'XYZA'.includes(w.letter));
  if (!motionWord && axisWords && (m.motion === 'G2' || m.motion === 'G3')) {
    blockers.push(`Line ${line} continues an arc (${m.motion}) without saying so. Start at the line that begins the arc.`);
  }
  if (m.motion !== 'G0' && m.motion !== 'G1' && m.motion !== 'G2' && m.motion !== 'G3' && axisWords && !motionWord) {
    blockers.push(`Line ${line} depends on motion mode ${m.motion}, which can't be restored.`);
  }
  if (m.feedMode === 'G94' && m.feed <= 0 && m.motion !== 'G0') {
    blockers.push('No feed rate has been set before this line.');
  }
  if (m.distance === 'G91') {
    warnings.push('The job uses incremental (G91) moves: positions after the start depend on where the skipped lines would have left the tool. Check the preview carefully.');
  }
  if (lastToolChange !== null) {
    warnings.push(`The last tool change before this line is on line ${lastToolChange}: make sure T${m.tool} is in the spindle and its length is set.`);
  }
  if (!spindleOn && !laser) {
    warnings.push('The spindle is off at this line (as the job had it).');
  }

  const p: string[] = [];
  p.push(`G21 G90 ${m.plane} ${m.feedMode === 'G93' ? 'G94' : m.feedMode}`);
  p.push(m.wcs);
  p.push(`G53 G0 Z${fmt(profile.safety.safeZMachine)}`);
  if (m.tool > 0) p.push(`T${m.tool}`);
  if (m.coolant.flood) p.push('M8');
  if (m.coolant.mist) p.push('M7');
  if (!laser && spindleOn) {
    p.push(`${m.spindle} S${fmt(m.speed)}`);
    const dwell = profile.spindle.spinUpDelaySec;
    if (dwell > 0) p.push(`G4 P${fmt(dwell)}`);
  }
  const xy = `X${fmt(start[0])} Y${fmt(start[1])}${profile.machineType === 'rotary' || Math.abs(start[3]) > 1e-9 ? ` A${fmt(start[3])}` : ''}`;
  p.push(`G0 ${xy}`);
  if (!laser) {
    const approach = start[2] + profile.safety.clearanceZ;
    p.push(`G0 Z${fmt(approach)}`);
    // The job's own plunge feed if it had one, else its current feed; never above the Z maximum.
    const plunge = Math.min(plungeFeed && plungeFeed > 0 ? plungeFeed : m.feed > 0 ? m.feed : profile.motion.maxRate.z / 4, profile.motion.maxRate.z);
    p.push(`G1 Z${fmt(start[2])} F${fmt(plunge)}`);
  } else {
    p.push(`G0 Z${fmt(start[2])}`);
    if (spindleOn) p.push(`${m.spindle} S${fmt(m.speed)}`);
  }
  // The job's own modes, last
  const inches = m.units === 'G20';
  const tail: string[] = [m.units, m.distance];
  if (m.feedMode === 'G93') tail.push('G93');
  else if (m.feed > 0) tail.push(`F${fmt(m.feed, inches)}`);
  if (m.motion === 'G0' || m.motion === 'G1') tail.push(m.motion);
  p.push(tail.join(' '));
  return { prelude: p, start, tool: m.tool, spindleOn, blockers, warnings };
}

/** Feed of the last straight-down G1 before source line `line` (the job's plunge feed), or null. */
export function lastPlungeFeed(tp: Toolpath, line: number): number | null {
  const s = [0, 0, 0, 0];
  for (let i = tp.count - 1; i >= 0; i--) {
    if (tp.line[i]! >= line) continue;
    if (tp.kind[i] !== SEG.feed) continue;
    segStartPoint(tp, i, s);
    const dz = tp.end[i * 4 + 2]! - s[2]!;
    const dxy = Math.hypot(tp.end[i * 4]! - s[0]!, tp.end[i * 4 + 1]! - s[1]!);
    if (dz < -1e-6 && dxy < 1e-6) return tp.feed[i]!;
  }
  return null;
}
