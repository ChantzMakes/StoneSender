/**
 * Module boundaries (spec §3). Every module talks to its neighbours only
 * through these types. Phase 1 implements the profile manager, transport,
 * part of the protocol layer and the virtual device; the rest are declared
 * here so later phases slot in without reshaping the app.
 *
 *   ┌──────────── UI (React panels, Zustand stores) ────────────┐
 *   │                                                           │
 *   │  ProfileManager   GcodeInterpreter → MotionPlanner         │
 *   │        │                  │               │                │
 *   │        │            ToolpathModel ──→ Simulator            │
 *   │        ▼                  ▼                                │
 *   │  Backend (IPC) ── JobStreamer / console queue (Rust)       │
 *   └────────┬──────────────────────────────────────────────────┘
 *            ▼
 *   Rust: grbl-link (Link, transports) → grbl-core (protocol, status)
 *            ▼                                 ▲
 *     serial port  or  virtual-grbl (emulator) ┘
 *
 * Rust-side counterparts: `grbl_core::transport::{ByteReader, ByteWriter,
 * TransportFactory}`, `grbl_link::{Link, EventSink}`.
 */
import type { MachineProfile } from '@/lib/profile/schema';
import type { ImportResult } from '@/lib/profile/share';

// ---------------------------------------------------------------------------
// 1. Profile manager (implemented: src/store/profiles.ts + src/lib/profile/*)
// ---------------------------------------------------------------------------
export interface ProfileManager {
  list(): MachineProfile[];
  active(): MachineProfile | null;
  setActive(id: string): void;
  save(p: MachineProfile): Promise<void>;
  createFromPreset(presetId: string, name?: string): MachineProfile;
  duplicate(id: string): Promise<MachineProfile>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  parseImport(text: string): ImportResult;
  exportJson(id: string): string;
  // Phase 2: diff against `$$` and sync in either direction
  diffWithController?(settings: Map<number, number>): SettingDiff[];
}

export interface SettingDiff {
  id: number;
  label: string;
  profileValue: number;
  controllerValue: number;
}

// ---------------------------------------------------------------------------
// 2+3. Transport & protocol (implemented in Rust; see src/lib/backend/types.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. G-code interpreter (Phase 3) — runs in a Web Worker
//
// Implemented in src/lib/gcode/: interpreter.ts (modal interpreter),
// planner.ts (time model), stats.ts, analyze.ts, worker.ts/client.ts.
// For memory reasons the real output is the columnar `Toolpath` in
// toolpath.ts (typed arrays, machine coordinates); the object types below
// describe one segment of it conceptually.
// ---------------------------------------------------------------------------
export type MotionKind = 'rapid' | 'feed' | 'arc-cw' | 'arc-ccw' | 'probe' | 'dwell';

export interface Vec4 {
  x: number;
  y: number;
  z: number;
  a: number;
}

export interface ModalState {
  motion: 'G0' | 'G1' | 'G2' | 'G3' | 'G38.2' | 'G38.3' | 'G38.4' | 'G38.5' | 'G80';
  plane: 'G17' | 'G18' | 'G19';
  units: 'G20' | 'G21';
  distance: 'G90' | 'G91';
  arcDistance: 'G91.1';
  feedMode: 'G93' | 'G94';
  wcs: 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59';
  spindle: 'M3' | 'M4' | 'M5';
  coolant: { mist: boolean; flood: boolean };
  tool: number;
  feed: number;
  speed: number;
}

/** One executable motion segment, all coordinates in mm (work coordinates). */
export interface MotionSegment {
  kind: MotionKind;
  line: number;
  from: Vec4;
  to: Vec4;
  /** arcs only */
  center?: { x: number; y: number; z: number };
  plane?: 'G17' | 'G18' | 'G19';
  feed: number;
  spindle: number;
  tool: number;
  /** dwell seconds */
  dwell?: number;
}

export interface InterpreterDiagnostic {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface InterpretResult {
  segments: MotionSegment[];
  diagnostics: InterpreterDiagnostic[];
  /** Modal state *before* each line — needed for start-from-line recovery. */
  modalAtLine(line: number): ModalState;
}

export interface GcodeInterpreter {
  interpret(source: string, initial?: Partial<ModalState>): Promise<InterpretResult>;
}

// ---------------------------------------------------------------------------
// 5. Motion planner model (Phase 3)
// ---------------------------------------------------------------------------
export interface PlannedSegment {
  segment: MotionSegment;
  entrySpeed: number;
  cruiseSpeed: number;
  exitSpeed: number;
  /** seconds from job start */
  startTime: number;
  duration: number;
}

export interface MotionPlanner {
  plan(segments: MotionSegment[], profile: MachineProfile): PlannedSegment[];
  estimateSeconds(segments: MotionSegment[], profile: MachineProfile): number;
}

// ---------------------------------------------------------------------------
// 6. Simulator (Phases 4–6)
// ---------------------------------------------------------------------------
export interface StockDefinition {
  size: { x: number; y: number; z: number };
  /** Stock origin relative to the work coordinate zero */
  origin: { x: number; y: number; z: number };
  material: string;
  color: string;
  /** rotary only */
  diameter?: number;
}

export interface ToolDefinition {
  id: number;
  kind: 'flat' | 'ball' | 'vbit' | 'engraver' | 'drill';
  diameter: number;
  angle?: number;
  fluteLength: number;
  stickout: number;
}

export interface SimulationFrame {
  time: number;
  position: Vec4;
  line: number;
}

export interface Simulator {
  load(planned: PlannedSegment[], profile: MachineProfile, stock: StockDefinition, tools: ToolDefinition[]): void;
  seek(time: number): SimulationFrame;
  duration(): number;
}

// ---------------------------------------------------------------------------
// Job streaming (Phase 2, Rust side) — exposed to the UI as:
// ---------------------------------------------------------------------------
export interface JobStreamer {
  start(lines: string[], opts: { startLine?: number; checkMode?: boolean }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}
