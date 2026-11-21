/**
 * Full modal-state G-code interpreter for the GRBL dialect.
 *
 * Produces a compact `Toolpath` in machine coordinates plus diagnostics that
 * mirror the controller's own errors (GRBL error codes where they apply).
 * Pure and synchronous — run it in a Web Worker for big files.
 *
 * Validation follows GRBL 1.1 `gcode.c`: modal group violations, repeated
 * words, missing feed, arc geometry, etc. Arc handling (IJK / R, all planes,
 * helical) matches GRBL's `mc_arc` so the planner sees the same geometry.
 */
import type { ModalState } from '@/core/interfaces';
import { SEG, FLAG, ToolpathBuilder, type Toolpath } from './toolpath';

const MM_PER_INCH = 25.4;

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  line: number;
  severity: Severity;
  message: string;
  /** GRBL error code this corresponds to, if any */
  code?: number;
}

export type Vec4 = [number, number, number, number];

/** Offsets in machine coordinates, as reported by `$#`. */
export interface Offsets {
  wcs: Vec4[]; // G54..G59
  g92: Vec4;
  tlo: number;
  g28: Vec4;
  g30: Vec4;
}

export interface InterpretOptions {
  /** Machine position at the start (default 0,0,0,0) */
  start?: Vec4;
  offsets?: Partial<Offsets>;
  /** Initial modal state (default: GRBL power-on state) */
  modal?: Partial<ModalState>;
  /** Laser mode ($32=1): spindle changes don't stop motion */
  laserMode?: boolean;
  /** 4th axis available */
  aAxis?: boolean;
  maxDiagnostics?: number;
  /** Store a modal checkpoint every N lines (for start-from-line) */
  checkpointEvery?: number;
}

export interface ToolChangeInfo {
  line: number;
  tool: number;
}

export interface Checkpoint {
  /** State *before* this source line */
  line: number;
  state: InterpState;
}

export interface InterpretResult {
  toolpath: Toolpath;
  diagnostics: Diagnostic[];
  diagnosticsTruncated: number;
  toolChanges: ToolChangeInfo[];
  pauses: number[];
  sourceLines: number;
  checkpoints: Checkpoint[];
  usesMachineCoords: boolean;
  changesOffsets: boolean;
  /** Work offset of the WCS active at the start (to convert machine → work) */
  startWorkOffset: Vec4;
  final: InterpState;
}

export interface InterpState {
  modal: ModalState;
  pos: Vec4;
  offsets: Offsets;
  /** Which offset index is active (0 = G54) */
  wcsIndex: number;
}

export function defaultModal(): ModalState {
  return {
    motion: 'G0',
    plane: 'G17',
    units: 'G21',
    distance: 'G90',
    arcDistance: 'G91.1',
    feedMode: 'G94',
    wcs: 'G54',
    spindle: 'M5',
    coolant: { mist: false, flood: false },
    tool: 0,
    feed: 0,
    speed: 0,
  };
}

function zero(): Vec4 {
  return [0, 0, 0, 0];
}

export function defaultOffsets(): Offsets {
  return { wcs: Array.from({ length: 6 }, zero), g92: zero(), tlo: 0, g28: zero(), g30: zero() };
}

function cloneState(s: InterpState): InterpState {
  return {
    modal: { ...s.modal, coolant: { ...s.modal.coolant } },
    pos: [...s.pos] as Vec4,
    offsets: { wcs: s.offsets.wcs.map((w) => [...w] as Vec4), g92: [...s.offsets.g92] as Vec4, tlo: s.offsets.tlo, g28: [...s.offsets.g28] as Vec4, g30: [...s.offsets.g30] as Vec4 },
    wcsIndex: s.wcsIndex,
  };
}

/** Rollback copy that shares `offsets` (only valid for lines that can't change them). */
function cloneMotionState(s: InterpState): InterpState {
  return { modal: { ...s.modal, coolant: { ...s.modal.coolant } }, pos: [s.pos[0], s.pos[1], s.pos[2], s.pos[3]], offsets: s.offsets, wcsIndex: s.wcsIndex };
}

/** G10, G28.1, G30.1, G43.1, G49, G92(.1), M2, M30 change offsets. */
function touchesOffsets(words: Word[]): boolean {
  for (const w of words) {
    if (w.letter === 'G') {
      const c = Math.round(w.value * 10);
      if (c === 100 || c === 281 || c === 301 || c === 431 || c === 490 || c === 920 || c === 921) return true;
    } else if (w.letter === 'M' && (w.value === 2 || w.value === 30)) return true;
  }
  return false;
}

/** Work offset (machine = work + offset) for the active WCS. */
export function workOffset(s: InterpState): Vec4 {
  const w = s.offsets.wcs[s.wcsIndex]!;
  return [w[0] + s.offsets.g92[0], w[1] + s.offsets.g92[1], w[2] + s.offsets.g92[2] + s.offsets.tlo, w[3] + s.offsets.g92[3]];
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

export interface Word {
  letter: string;
  value: number;
}

/**
 * Strip comments / whitespace and split into words, the way GRBL's input
 * filter does. Returns an error message for malformed lines.
 */
const POW10 = Array.from({ length: 16 }, (_, i) => 10 ** i);
const LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

export function tokenize(raw: string): { words: Word[]; error?: { message: string; code: number } } {
  // Hot path (millions of lines): scan by char code, parse each number once.
  const words: Word[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const code = raw.charCodeAt(i);
    if (code === 40 /* ( */) {
      const close = raw.indexOf(')', i);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (code === 59 /* ; */) break;
    if (code === 32 || code === 9 || code === 13 || code === 37 /* space tab CR % */) {
      i++;
      continue;
    }
    const upper = code & ~32;
    if (upper < 65 || upper > 90) {
      if ((code >= 48 && code <= 57) || code === 46 || code === 45 || code === 43) return { words, error: { message: `number without a letter in front of it`, code: 1 } };
      return { words, error: { message: `unexpected character '${raw[i]}'`, code: 1 } };
    }
    const letter = LETTERS[upper - 65]!;
    i++;
    // number: characters 0-9 . + - (spaces inside numbers are allowed by GRBL's filter)
    let start = -1;
    let end = -1;
    let dots = 0;
    let digits = 0;
    // exact fast path: integer mantissa / 10^k is correctly rounded while mantissa < 2^53
    let mant = 0;
    let frac = 0;
    let neg = false;
    let badSign = false;
    let text = '';
    let split = false;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        digits++;
        mant = mant * 10 + (c - 48);
        if (dots) frac++;
      } else if (c === 46) dots++;
      else if (c === 45 || c === 43) {
        if (start >= 0 || split) badSign = true;
        else neg = c === 45;
      } else if (c === 32 || c === 9 || c === 13) {
        if (start >= 0) {
          // whitespace inside a number: keep scanning only if more number follows
          let j = i + 1;
          while (j < n && (raw.charCodeAt(j) === 32 || raw.charCodeAt(j) === 9 || raw.charCodeAt(j) === 13)) j++;
          const d = j < n ? raw.charCodeAt(j) : 0;
          if ((d >= 48 && d <= 57) || d === 46 || d === 45 || d === 43) {
            text += raw.slice(start, end);
            start = -1;
            split = true;
            i = j;
            continue;
          }
        }
        i++;
        if (start < 0 && !split) continue;
        break;
      } else break;
      if (start < 0) start = i;
      end = i + 1;
      i++;
    }
    if (digits > 0 && !badSign && dots <= 1 && digits <= 15) {
      const v = frac ? mant / POW10[frac]! : mant;
      words.push({ letter, value: neg ? -v : v });
      continue;
    }
    const num = start >= 0 ? text + raw.slice(start, end) : text;
    if (num === '' || digits === 0) return { words, error: { message: `'${letter}' needs a number`, code: 2 } };
    const v = badSign || dots > 1 ? NaN : Number(num);
    if (!Number.isFinite(v)) return { words, error: { message: `'${letter}${num}' is not a valid number`, code: 2 } };
    words.push({ letter, value: v });
  }
  return { words };
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

const PLANE_AXES: Record<ModalState['plane'], [number, number, number]> = {
  G17: [0, 1, 2],
  G18: [2, 0, 1],
  G19: [1, 2, 0],
};
const PLANE_INDEX: Record<ModalState['plane'], number> = { G17: 0, G18: 1, G19: 2 };
const OFFSET_LETTER = ['I', 'J', 'K'];
const WCS_NAMES: ModalState['wcs'][] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];

class LineError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}

export class Interpreter {
  state: InterpState;
  private tp: ToolpathBuilder;
  private diags: Diagnostic[] = [];
  private diagsTruncated = 0;
  private maxDiags: number;
  private laserMode: boolean;
  private aAxis: boolean;
  private pendingSync = false;
  private pendingPause = false;
  private programEnded = false;
  private warnedAfterEnd = false;
  toolChanges: ToolChangeInfo[] = [];
  pauses: number[] = [];
  /** Job uses G53 / changes offsets (G10, G92, G43.1, WCS switch): bounds depend on controller offsets */
  usesMachineCoords = false;
  changesOffsets = false;
  checkpoints: Checkpoint[] = [];
  private checkpointEvery: number;
  private groupsSeen = new Set<string>();
  private vals = new Map<string, number>();
  lines = 0;

  constructor(opts: InterpretOptions = {}) {
    const offsets = { ...defaultOffsets(), ...opts.offsets };
    const modal = { ...defaultModal(), ...opts.modal };
    this.state = { modal, pos: [...(opts.start ?? zero())] as Vec4, offsets, wcsIndex: WCS_NAMES.indexOf(modal.wcs) };
    this.tp = new ToolpathBuilder();
    this.tp.origin.set(this.state.pos);
    this.maxDiags = opts.maxDiagnostics ?? 500;
    this.laserMode = opts.laserMode ?? false;
    this.aAxis = opts.aAxis ?? false;
    this.checkpointEvery = opts.checkpointEvery ?? 1000;
  }

  diag(line: number, severity: Severity, message: string, code?: number) {
    if (this.diags.length < this.maxDiags) this.diags.push({ line, severity, message, code });
    else this.diagsTruncated++;
  }

  /** Interpret one source line (1-based number). */
  line(raw: string, n: number) {
    this.lines = n;
    if ((n - 1) % this.checkpointEvery === 0) this.checkpoints.push({ line: n, state: cloneState(this.state) });
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('$')) {
      this.system(trimmed, n);
      return;
    }
    const { words, error } = tokenize(raw);
    if (error) {
      this.diag(n, 'error', error.message, error.code);
      return;
    }
    if (words.length === 0) return;
    if (this.programEnded && !this.warnedAfterEnd) {
      this.warnedAfterEnd = true;
      this.diag(n, 'info', 'commands after the program end (M2/M30) — they still run');
    }
    // Offsets change only on these words; other lines can share them in the rollback snapshot.
    const snapshot = touchesOffsets(words) ? cloneState(this.state) : cloneMotionState(this.state);
    const mark = { seg: this.tp.count, arc: this.tp.arcCount, tc: this.toolChanges.length, pause: this.pauses.length, sync: this.pendingSync, paused: this.pendingPause, ended: this.programEnded };
    try {
      this.execute(words, n);
    } catch (e) {
      // GRBL rejects the whole line: restore everything it might have changed.
      this.state = snapshot;
      this.tp.truncate(mark.seg, mark.arc);
      this.toolChanges.length = mark.tc;
      this.pauses.length = mark.pause;
      this.pendingSync = mark.sync;
      this.pendingPause = mark.paused;
      this.programEnded = mark.ended;
      if (e instanceof LineError) this.diag(n, 'error', e.message, e.code);
      else throw e;
    }
  }

  private system(text: string, n: number) {
    const t = text.replace(/\s+/g, '').toUpperCase();
    if (t.startsWith('$J=')) {
      this.diag(n, 'warning', 'jog command inside a job');
      return;
    }
    if (t === '$H') {
      this.diag(n, 'warning', 'homing cycle inside the job — position afterwards is the home position');
      this.pendingSync = true;
      return;
    }
    if (/^\$\d+=/.test(t)) {
      this.diag(n, 'error', 'changes a controller setting — not allowed in a job');
      return;
    }
    this.diag(n, 'warning', `system command ${t}`);
  }

  private execute(words: Word[], n: number) {
    const s = this.state;
    const m = s.modal;
    let motion: ModalState['motion'] | null = null;
    let nonModal: number | null = null;
    let g53 = false;
    let tloCmd: 'set' | 'clear' | null = null;
    let stop: number | null = null;
    let spindleCmd: ModalState['spindle'] | null = null;
    const coolantCmds: number[] = [];
    let m6 = false;
    const groups = this.groupsSeen;
    const vals = this.vals;
    groups.clear();
    vals.clear();
    const group = (g: string) => {
      if (groups.has(g)) throw new LineError('two commands from the same group on one line', 21);
      groups.add(g);
    };

    for (const w of words) {
      if (w.letter === 'G') {
        const code = Math.round(w.value * 10);
        switch (code) {
          case 0:
          case 10:
          case 20:
          case 30:
          case 800:
            group('motion');
            motion = code === 0 ? 'G0' : code === 10 ? 'G1' : code === 20 ? 'G2' : code === 30 ? 'G3' : 'G80';
            break;
          case 382:
          case 383:
          case 384:
          case 385:
            group('motion');
            motion = `G38.${code - 380}` as ModalState['motion'];
            break;
          case 170:
          case 180:
          case 190:
            group('plane');
            m.plane = `G${code / 10}` as ModalState['plane'];
            break;
          case 900:
          case 910:
            group('distance');
            m.distance = code === 900 ? 'G90' : 'G91';
            break;
          case 911:
            group('arcDistance');
            break;
          case 930:
          case 940:
            group('feedMode');
            m.feedMode = code === 930 ? 'G93' : 'G94';
            break;
          case 200:
          case 210:
            group('units');
            m.units = code === 200 ? 'G20' : 'G21';
            break;
          case 400:
            group('cutterComp');
            break;
          case 431:
          case 490:
            group('tlo');
            tloCmd = code === 431 ? 'set' : 'clear';
            break;
          case 540:
          case 550:
          case 560:
          case 570:
          case 580:
          case 590:
            group('wcs');
            if ((code - 540) / 10 !== s.wcsIndex) this.changesOffsets = true;
            s.wcsIndex = (code - 540) / 10;
            m.wcs = WCS_NAMES[s.wcsIndex]!;
            break;
          case 610:
            group('pathMode');
            break;
          case 40:
          case 100:
          case 280:
          case 281:
          case 300:
          case 301:
          case 920:
          case 921:
            group('nonModal');
            nonModal = code;
            break;
          case 530:
            group('nonModal');
            g53 = true;
            this.usesMachineCoords = true;
            break;
          case 410:
          case 420:
            throw new LineError(`G${code / 10} (cutter compensation) is not supported by GRBL`, 20);
          default:
            if (code >= 810 && code <= 890) throw new LineError(`G${w.value} (canned cycle) is not supported by GRBL`, 20);
            throw new LineError(`G${w.value} is not supported`, 20);
        }
      } else if (w.letter === 'M') {
        if (!Number.isInteger(w.value)) throw new LineError(`M${w.value} must be a whole number`, 23);
        switch (w.value) {
          case 0:
          case 1:
          case 2:
          case 30:
            group('stop');
            stop = w.value;
            break;
          case 3:
          case 4:
          case 5:
            group('spindle');
            spindleCmd = `M${w.value}` as ModalState['spindle'];
            break;
          case 7:
          case 8:
          case 9:
            coolantCmds.push(w.value);
            break;
          case 6:
            group('toolChange');
            m6 = true;
            break;
          default:
            throw new LineError(`M${w.value} is not supported`, 20);
        }
      } else if (w.letter === 'N') {
        if (w.value < 0 || w.value > 9_999_999) throw new LineError('invalid line number', 27);
      } else if ('FSTPRLXYZAIJK'.includes(w.letter)) {
        if (w.letter === 'A' && !this.aAxis) throw new LineError('A axis words need a 4-axis machine', 20);
        if (vals.has(w.letter)) throw new LineError(`'${w.letter}' appears twice`, 25);
        vals.set(w.letter, w.value);
      } else {
        throw new LineError(`the '${w.letter}' word is not supported by GRBL`, 20);
      }
    }
    if (coolantCmds.length > 1 && coolantCmds.includes(9)) throw new LineError('M9 with M7/M8 on the same line', 21);

    const inches = m.units === 'G20';
    const toMm = (v: number) => (inches ? v * MM_PER_INCH : v);
    const axisVals: (number | undefined)[] = [vals.get('X'), vals.get('Y'), vals.get('Z'), vals.get('A')];
    const hasAxes = axisVals.some((v) => v !== undefined);
    const axisNonModal = nonModal === 100 || nonModal === 280 || nonModal === 300 || nonModal === 920;
    if (axisNonModal && motion && hasAxes) throw new LineError('two commands on the line both need the axis words', 24);

    // --- order of execution (GRBL gcode.c)
    const f = vals.get('F');
    if (f !== undefined) {
      if (f < 0) throw new LineError('feed rate is negative', 4);
      if (m.feedMode === 'G94') m.feed = toMm(f);
    }
    const sVal = vals.get('S');
    let speedChanged = false;
    if (sVal !== undefined) {
      if (sVal < 0) throw new LineError('spindle speed is negative', 4);
      speedChanged = sVal !== m.speed;
      m.speed = sVal;
    }
    const t = vals.get('T');
    if (t !== undefined) {
      if (t > 255 || t < 0 || !Number.isInteger(t)) throw new LineError('invalid tool number', 38);
      m.tool = t;
    }
    if (m6) this.toolChanges.push({ line: n, tool: m.tool });
    if (spindleCmd) {
      if (spindleCmd !== m.spindle && !this.laserMode) this.pendingSync = true;
      m.spindle = spindleCmd;
    } else if (speedChanged && m.spindle !== 'M5' && !this.laserMode) {
      this.pendingSync = true;
    }
    for (const c of coolantCmds) {
      if (c === 7) m.coolant.mist = true;
      if (c === 8) m.coolant.flood = true;
      if (c === 9) m.coolant = { mist: false, flood: false };
      this.pendingSync = true;
    }
    if (nonModal === 40) {
      const p = vals.get('P');
      if (p === undefined) throw new LineError('G4 dwell needs a P value (seconds)', 28);
      if (p < 0) throw new LineError('negative dwell', 4);
      this.emitDwell(n, p);
    }
    if (tloCmd) this.changesOffsets = true;
    if (nonModal === 100 || nonModal === 920 || nonModal === 921) this.changesOffsets = true;
    if (nonModal === 280 || nonModal === 300) this.usesMachineCoords = true;
    if (tloCmd === 'set') {
      const z = axisVals[2];
      if (z === undefined) throw new LineError('G43.1 needs a Z value', 28);
      s.offsets.tlo = toMm(z);
      axisVals[2] = undefined;
    } else if (tloCmd === 'clear') {
      s.offsets.tlo = 0;
    }
    if (g53 && !['G0', 'G1'].includes(motion ?? m.motion)) throw new LineError('G53 only works with G0 or G1', 30);

    const resolve = (axes: (number | undefined)[], abs: boolean, machine: boolean): Vec4 => {
      const wo = workOffset(s);
      const out = [...s.pos] as Vec4;
      for (let i = 0; i < 4; i++) {
        const v = axes[i];
        if (v === undefined) continue;
        const mm = i < 3 ? toMm(v) : v;
        out[i] = machine ? mm : abs ? mm + wo[i]! : s.pos[i]! + mm;
      }
      return out;
    };

    let consumedAxes = false;
    switch (nonModal) {
      case 100: {
        const l = vals.get('L');
        const p = vals.get('P');
        if (l === undefined || p === undefined) throw new LineError('G10 needs L and P', 28);
        if (!(l === 2 || l === 20)) throw new LineError(`G10 L${l} is not supported`, 20);
        if (p < 0 || p > 6 || !Number.isInteger(p)) throw new LineError('G10 P must be 0–6', 29);
        const idx = p === 0 ? s.wcsIndex : p - 1;
        const target = s.offsets.wcs[idx]!;
        for (let i = 0; i < 4; i++) {
          const v = axisVals[i];
          if (v === undefined) continue;
          const mm = i < 3 ? toMm(v) : v;
          target[i] = l === 2 ? mm : s.pos[i]! - s.offsets.g92[i]! - mm - (i === 2 ? s.offsets.tlo : 0);
        }
        consumedAxes = true;
        break;
      }
      case 281:
        s.offsets.g28 = [...s.pos] as Vec4;
        break;
      case 301:
        s.offsets.g30 = [...s.pos] as Vec4;
        break;
      case 920:
        if (!hasAxes) throw new LineError('G92 needs axis words', 26);
        for (let i = 0; i < 4; i++) {
          const v = axisVals[i];
          if (v === undefined) continue;
          const mm = i < 3 ? toMm(v) : v;
          s.offsets.g92[i] = s.pos[i]! - s.offsets.wcs[s.wcsIndex]![i]! - mm - (i === 2 ? s.offsets.tlo : 0);
        }
        consumedAxes = true;
        break;
      case 921:
        s.offsets.g92 = zero();
        break;
      case 280:
      case 300: {
        const stored = nonModal === 280 ? s.offsets.g28 : s.offsets.g30;
        let final: Vec4;
        if (hasAxes) {
          const mid = resolve(axisVals, m.distance === 'G90', false);
          this.emitLine(SEG.rapid, n, mid, 0, 0);
          final = [...mid] as Vec4;
          for (let i = 0; i < 4; i++) if (axisVals[i] !== undefined) final[i] = stored[i]!;
        } else {
          final = [...stored] as Vec4;
        }
        this.emitLine(SEG.rapid, n, final, 0, 0);
        consumedAxes = true;
        break;
      }
    }

    if (motion) m.motion = motion;
    const effective = motion ?? m.motion;
    const hasMotionAxes = !consumedAxes && axisVals.some((v) => v !== undefined);

    if (hasMotionAxes) {
      const target = resolve(axisVals, m.distance === 'G90', g53);
      const feed = (): number => {
        if (m.feedMode === 'G93') {
          if (f === undefined) throw new LineError('inverse time mode (G93) needs F on every move', 22);
          const len = Math.hypot(target[0] - s.pos[0], target[1] - s.pos[1], target[2] - s.pos[2], target[3] - s.pos[3]);
          return Math.max(len * f, 1);
        }
        if (m.feed <= 0) throw new LineError('cutting move without a feed rate (F)', 22);
        return m.feed;
      };
      const flags = (g53 ? FLAG.machine : 0) | (m.feedMode === 'G93' ? FLAG.inverseTime : 0);
      switch (effective) {
        case 'G80':
          throw new LineError('axis words with no motion command (G80 active)', 31);
        case 'G0':
          this.emitLine(SEG.rapid, n, target, 0, flags);
          break;
        case 'G1':
          this.emitLine(SEG.feed, n, target, feed(), flags);
          break;
        case 'G2':
        case 'G3':
          this.emitArc(n, target, vals, effective === 'G2', feed(), toMm);
          break;
        default: {
          // G38.x probing
          if (target.every((v, i) => Math.abs(v - s.pos[i]!) < 1e-9)) throw new LineError('probe target equals the current position', 33);
          this.pendingSync = true;
          this.emitLine(SEG.probe, n, target, feed(), flags);
          this.pendingSync = true;
          this.diag(n, 'info', 'probing move: the path assumes no contact (real moves stop at the surface)');
        }
      }
    } else if (motion === 'G2' || motion === 'G3') {
      throw new LineError('arc without an end point in its plane', 32);
    } else if (motion?.startsWith('G38')) {
      throw new LineError('probe move without a target', 26);
    }

    if (stop !== null) {
      if (stop === 0 || stop === 1) {
        if (stop === 0) {
          this.pauses.push(n);
          this.pendingPause = true;
          this.pendingSync = true;
        }
      } else {
        // M2 / M30: program end resets modal state like GRBL
        this.pendingSync = true;
        this.programEnded = true;
        m.motion = 'G1';
        m.plane = 'G17';
        m.distance = 'G90';
        m.feedMode = 'G94';
        m.wcs = 'G54';
        s.wcsIndex = 0;
        m.spindle = 'M5';
        m.coolant = { mist: false, flood: false };
        s.offsets.g92 = zero();
      }
    }
  }

  private flagsNow(extra: number): number {
    let f = extra;
    if (this.pendingSync) f |= FLAG.sync;
    if (this.pendingPause) f |= FLAG.pause;
    if (this.state.modal.spindle !== 'M5') f |= FLAG.powerOn;
    this.pendingSync = false;
    this.pendingPause = false;
    return f;
  }

  private emitDwell(n: number, seconds: number) {
    const s = this.state;
    this.pendingSync = true;
    this.tp.push(SEG.dwell, this.flagsNow(0), n, s.pos, seconds, this.spindleNow(), s.modal.tool);
  }

  private spindleNow(): number {
    return this.state.modal.spindle === 'M5' ? 0 : this.state.modal.speed;
  }

  private emitLine(kind: number, n: number, target: Vec4, feed: number, flags: number) {
    const s = this.state;
    const same = target.every((v, i) => Math.abs(v - s.pos[i]!) < 1e-9);
    if (same) return;
    this.tp.push(kind as 0, this.flagsNow(flags), n, target, feed, this.spindleNow(), s.modal.tool);
    s.pos = target;
  }

  private emitArc(n: number, target: Vec4, vals: Map<string, number>, cw: boolean, feed: number, toMm: (v: number) => number) {
    const s = this.state;
    const [a0, a1, lin] = PLANE_AXES[s.modal.plane];
    const start = s.pos;
    let off0: number;
    let off1: number;
    const r = vals.get('R');
    if (r !== undefined) {
      const rr = toMm(r);
      const x = target[a0]! - start[a0]!;
      const y = target[a1]! - start[a1]!;
      if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) throw new LineError('R-form arc cannot end where it starts', 33);
      let h = 4 * rr * rr - x * x - y * y;
      if (h < 0) throw new LineError('arc radius too small to reach the end point', 34);
      h = -Math.sqrt(h) / Math.hypot(x, y);
      if (!cw) h = -h;
      if (rr < 0) h = -h;
      off0 = 0.5 * (x - y * h);
      off1 = 0.5 * (y + x * h);
    } else {
      const i0 = vals.get(OFFSET_LETTER[a0]!);
      const i1 = vals.get(OFFSET_LETTER[a1]!);
      if (i0 === undefined && i1 === undefined) throw new LineError('arc needs I/J/K offsets (or R) in its plane', 35);
      off0 = toMm(i0 ?? 0);
      off1 = toMm(i1 ?? 0);
      const rStart = Math.hypot(off0, off1);
      const rEnd = Math.hypot(target[a0]! - (start[a0]! + off0), target[a1]! - (start[a1]! + off1));
      const delta = Math.abs(rEnd - rStart);
      if (delta > 0.005 && (delta > 0.5 || delta > 0.001 * rStart)) throw new LineError(`arc end point is ${delta.toFixed(3)} mm off the circle`, 33);
    }
    const c0 = start[a0]! + off0;
    const c1 = start[a1]! + off1;
    const r0 = -off0;
    const r1 = -off1;
    const rt0 = target[a0]! - c0;
    const rt1 = target[a1]! - c1;
    let angle = Math.atan2(r0 * rt1 - r1 * rt0, r0 * rt0 + r1 * rt1);
    const EPS = 5e-7;
    if (cw) {
      if (angle >= -EPS) angle -= 2 * Math.PI;
    } else if (angle <= EPS) {
      angle += 2 * Math.PI;
    }
    const center: Vec4 = [0, 0, 0, 0];
    center[a0] = c0;
    center[a1] = c1;
    center[lin] = start[lin]!;
    this.tp.push(cw ? SEG.arcCw : SEG.arcCcw, this.flagsNow(this.state.modal.feedMode === 'G93' ? FLAG.inverseTime : 0), n, target, feed, this.spindleNow(), s.modal.tool, {
      cx: center[0],
      cy: center[1],
      cz: center[2],
      angle,
      plane: PLANE_INDEX[s.modal.plane],
    });
    s.pos = target;
  }

  finish(): InterpretResult {
    return {
      toolpath: this.tp.finish(),
      diagnostics: this.diags,
      diagnosticsTruncated: this.diagsTruncated,
      toolChanges: this.toolChanges,
      pauses: this.pauses,
      sourceLines: this.lines,
      checkpoints: this.checkpoints,
      usesMachineCoords: this.usesMachineCoords,
      changesOffsets: this.changesOffsets,
      startWorkOffset: [0, 0, 0, 0],
      final: cloneState(this.state),
    };
  }
}

/** Split text into lines the same way Rust's `str::lines` does (\n or \r\n). */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Calls `fn(line, n)` for each line like `splitLines`, without building the array. */
export function forEachLine(text: string, fn: (line: string, n: number) => void, from = 1, to = Infinity) {
  let pos = 0;
  let n = 0;
  const len = text.length;
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = len;
    n++;
    if (n > to) return;
    if (n >= from) fn(text.charCodeAt(nl - 1) === 13 && nl > pos ? text.slice(pos, nl - 1) : text.slice(pos, nl), n);
    pos = nl + 1;
  }
}

export function interpret(text: string, opts: InterpretOptions = {}, onProgress?: (done: number, total: number) => void): InterpretResult {
  const it = new Interpreter(opts);
  const startWo = workOffset(it.state);
  // progress by characters: no up-front line count needed
  const total = text.length;
  let next = 0;
  let pos = 0;
  forEachLine(text, (l, n) => {
    pos += l.length + 1;
    it.line(l, n);
    if (onProgress && pos >= next) {
      next = pos + 2_000_000;
      onProgress(pos, total);
    }
  });
  const r = it.finish();
  r.startWorkOffset = startWo;
  return r;
}

/** Modal state + position just *before* source line `line` (for start-from-line). */
export function stateBeforeLine(text: string, result: Pick<InterpretResult, 'checkpoints'>, line: number, opts: InterpretOptions = {}): InterpState {
  const cps = result.checkpoints;
  let cp: Checkpoint | undefined;
  for (const c of cps) {
    if (c.line <= line) cp = c;
    else break;
  }
  const it = new Interpreter({ ...opts, checkpointEvery: Number.MAX_SAFE_INTEGER });
  let from = 1;
  if (cp) {
    it.state = cloneState(cp.state);
    from = cp.line;
  }
  forEachLine(text, (l, i) => it.line(l, i), from, line - 1);
  return cloneState(it.state);
}
