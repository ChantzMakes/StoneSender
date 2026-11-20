/**
 * IPC contract with the Rust backend. These types mirror the serde output of
 * `grbl_link::LinkEvent`, `grbl_core::protocol::GrblLine`,
 * `grbl_core::status::MachineStatus` etc. Keep them in sync.
 */
import type { MachineProfile } from '@/lib/profile/schema';

export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'lost' | 'reconnecting';

export type MachineStateName = 'idle' | 'run' | 'hold' | 'jog' | 'alarm' | 'door' | 'check' | 'home' | 'sleep' | 'tool' | 'unknown';

export interface MachineState {
  name: MachineStateName;
  sub?: number | string;
}

export interface Overrides {
  feed: number;
  rapid: number;
  spindle: number;
}

export interface Pins {
  x: boolean;
  y: boolean;
  z: boolean;
  a: boolean;
  probe: boolean;
  door: boolean;
  hold: boolean;
  softReset: boolean;
  cycleStart: boolean;
  raw: string;
}

export interface Accessories {
  spindleCw: boolean;
  spindleCcw: boolean;
  flood: boolean;
  mist: boolean;
  raw: string;
}

export interface MachineStatus {
  state: MachineState | null;
  mpos: number[];
  wpos: number[];
  wco: number[];
  feed: number;
  spindle: number;
  buffer: { plannerFree: number; rxFree: number } | null;
  line: number | null;
  overrides: Overrides;
  pins: Pins;
  accessories: Accessories;
}

export interface FirmwareInfo {
  kind: 'grbl' | 'grblhal' | 'unknown';
  version: string;
  major: number;
  minor: number;
  legacy: boolean;
  warnings: string[];
  banner: string;
}

export type GrblLine =
  | { type: 'ok' }
  | { type: 'error'; code: number | null; text: string }
  | { type: 'alarm'; code: number | null; text: string }
  | { type: 'status'; report: unknown }
  | { type: 'welcome'; info: FirmwareInfo }
  | { type: 'setting'; id: number; value: string }
  | { type: 'message'; text: string }
  | { type: 'parserState'; words: string[] }
  | { type: 'probe'; position: number[]; success: boolean }
  | { type: 'offset'; name: string; values: number[] }
  | { type: 'version'; text: string }
  | { type: 'options'; text: string }
  | { type: 'echo'; text: string }
  | { type: 'help'; text: string }
  | { type: 'feedback'; text: string }
  | { type: 'startupBlock'; text: string }
  | { type: 'other'; text: string };

export interface BuildInfo {
  version: string | null;
  buildDate: string | null;
  options: string | null;
  plannerBlocks: number | null;
  rxBuffer: number | null;
  grblhal: boolean;
}

/** From `$$`, `$#`, `$G`, `$I` (grbl_link::ControllerInfo). Settings keys are setting ids. */
export interface ControllerInfo {
  settings: Record<string, string>;
  offsets: Record<string, number[]>;
  parserState: string[];
  build: BuildInfo;
  probe: { position: number[]; success: boolean } | null;
  rxBuffer: number;
  charCounting: boolean;
}

export type JobMode = 'run' | 'check';
export type JobPhase = 'starting' | 'running' | 'paused' | 'paused-on-error' | 'finishing' | 'stopping' | 'completed' | 'stopped' | 'failed';

export interface JobError {
  sourceLine: number;
  code: number | null;
  text: string;
  lineText: string;
}

export interface JobProgress {
  name: string;
  mode: JobMode;
  phase: JobPhase;
  total: number;
  sent: number;
  acked: number;
  currentLine: number;
  elapsedMs: number;
  errorCount: number;
  errors: JobError[];
  message: string | null;
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ScanIssue {
  line: number;
  severity: IssueSeverity;
  code: string;
  message: string;
}

export interface JobFeatures {
  unitsMm: boolean;
  unitsInch: boolean;
  spindleCw: boolean;
  spindleCcw: boolean;
  maxS: number;
  sChangesOnMoves: number;
  toolChanges: { line: number; tool: number | null }[];
  tools: number[];
  arcs: boolean;
  probe: boolean;
  coolantMist: boolean;
  coolantFlood: boolean;
  zWords: number;
  aWords: number;
  wcsUsed: string[];
  programEnd: boolean;
  systemCommands: number;
  dwellAfterSpindle: boolean;
}

export interface JobScan {
  sourceLines: number;
  lines: number;
  bytes: number;
  issues: ScanIssue[];
  issuesTruncated: number;
  features: JobFeatures;
}

export interface LoadedJob {
  name: string;
  path: string;
  sizeBytes: number;
  scan: JobScan;
}

export type LinkEvent =
  | { type: 'state'; state: LinkState; description: string | null; message: string | null }
  | { type: 'rx'; line: string; parsed: GrblLine; ts: number }
  | { type: 'tx'; line: string; realtime: boolean; ts: number }
  | { type: 'status'; status: MachineStatus; ts: number }
  | { type: 'firmware'; info: FirmwareInfo }
  | { type: 'queue'; pending: number; inFlight: boolean; dropped: number }
  | { type: 'controller'; info: ControllerInfo }
  | { type: 'job'; progress: JobProgress };

export interface LinkSnapshot {
  state: LinkState;
  description: string | null;
  firmware: FirmwareInfo | null;
  status: MachineStatus | null;
  controller?: ControllerInfo;
  job?: JobProgress | null;
}

export interface PortInfo {
  path: string;
  label: string;
  kind: 'usb' | 'bluetooth' | 'pci' | 'unknown';
  vid: number | null;
  pid: number | null;
  manufacturer: string | null;
  likelyGrbl: boolean;
}

export type VirtualFlavor = 'grbl11' | 'grbl09' | 'grblhal';

export type ConnectTarget =
  | { kind: 'serial'; path: string; baud: number }
  | { kind: 'virtual'; profile: MachineProfile; flavor: VirtualFlavor; timeScale?: number };

export interface ConnectRequest {
  target: ConnectTarget;
  pollHz: number;
  autoReconnect: boolean;
  charCounting: boolean;
  rxBuffer: number;
}

export type FaultRequest =
  | { kind: 'disconnect' }
  | { kind: 'alarm'; code: number }
  | { kind: 'errorOnNextLine'; code: number }
  | { kind: 'dropNextOk' }
  | { kind: 'stall'; seconds: number };

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface Backend {
  readonly kind: 'tauri' | 'browser';
  // persistence
  listProfiles(): Promise<unknown[]>;
  saveProfile(p: MachineProfile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  loadAppSettings(): Promise<unknown | null>;
  saveAppSettings(settings: unknown): Promise<void>;
  dataDir(): Promise<string>;
  // files (user-chosen via native dialogs)
  openTextFile(opts: { title: string; filters: FileFilter[] }): Promise<{ name: string; text: string } | null>;
  saveTextFile(opts: { title: string; defaultName: string; filters: FileFilter[]; text: string }): Promise<boolean>;
  /** Save bytes (STL / PNG exports) to a user-chosen file. */
  saveBinaryFile(opts: { title: string; defaultName: string; filters: FileFilter[]; bytes: Uint8Array; mime: string }): Promise<boolean>;
  // link
  listPorts(): Promise<PortInfo[]>;
  connect(req: ConnectRequest): Promise<void>;
  disconnect(): Promise<void>;
  sendLine(line: string): Promise<void>;
  sendRealtime(byte: number): Promise<void>;
  snapshot(): Promise<LinkSnapshot>;
  injectFault(fault: FaultRequest): Promise<void>;
  onLinkEvent(cb: (e: LinkEvent) => void): Promise<() => void>;
  // jobs (Phase 2)
  /** Native file dialog → load. Returns the scan plus the text (for analysis/editor). */
  openJob(): Promise<{ job: LoadedJob; text: string } | null>;
  /** Load a file by path (drag-and-drop, recent files). Desktop only. */
  loadJobPath(path: string): Promise<{ job: LoadedJob; text: string }>;
  /** Load text that is already in the UI (edited in the editor, dropped in the browser). */
  loadJobText(name: string, text: string): Promise<LoadedJob>;
  jobStart(mode: JobMode): Promise<void>;
  jobPause(): Promise<void>;
  jobResume(): Promise<void>;
  jobStop(): Promise<void>;
  jobUnload(): Promise<void>;
  // jogging & controller
  jogStart(dir: [number, number, number], feed: number, accel: number): Promise<void>;
  jogHeartbeat(): Promise<void>;
  jogStop(): Promise<void>;
  controllerRefresh(): Promise<void>;
}
