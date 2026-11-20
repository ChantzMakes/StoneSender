/** Connection state, fed by backend link events. */
import { create } from 'zustand';
import {
  backend,
  type ControllerInfo,
  type FirmwareInfo,
  type JobMode,
  type JobProgress,
  type JobStartOptions,
  type LinkEvent,
  type LinkState,
  type LoadedJob,
  type MachineStatus,
  type PortInfo,
  type VirtualFlavor,
} from '@/lib/backend';
import { alarmInfo, errorInfo } from '@/lib/grbl/codes';
import { onLinkEvent as commanderEvent, setReportInches } from '@/lib/machine/commander';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { useApp } from './app';
import { sysMessage, useConsole } from './console';

export const VIRTUAL_PORT = '__virtual__';

interface LinkStore {
  state: LinkState;
  description: string | null;
  message: string | null;
  firmware: FirmwareInfo | null;
  status: MachineStatus | null;
  controller: ControllerInfo | null;
  job: JobProgress | null;
  loadedJob: LoadedJob | null;
  /** Full text of the loaded job (for analysis and the editor) */
  jobText: string | null;
  /** Most recent ALARM code (cleared when the alarm state ends) */
  lastAlarm: { code: number | null; text: string; at: number } | null;
  lastStatusAt: number | null;
  lastRxAt: number | null;
  queue: { pending: number; inFlight: boolean };
  ports: PortInfo[];
  portsLoading: boolean;
  /** Profile the current connection was made with. */
  connectedProfileId: string | null;
  init(): Promise<void>;
  refreshPorts(): Promise<void>;
  connect(port: string, profile: MachineProfile, opts?: { flavor?: VirtualFlavor; timeScale?: number }): Promise<void>;
  disconnect(): Promise<void>;
  sendLine(line: string): Promise<void>;
  /** Send several lines in order (each still validated and queued). */
  sendLines(lines: string[]): Promise<void>;
  sendRealtime(byte: number): Promise<void>;
  refreshController(): Promise<void>;
  openJob(): Promise<void>;
  loadJobPath(path: string): Promise<void>;
  /** Replace the loaded job with edited text */
  loadJobText(name: string, text: string): Promise<void>;
  unloadJob(): Promise<void>;
  startJob(mode: JobMode, options?: JobStartOptions): Promise<void>;
  toolChangeDone(): Promise<void>;
}

let unlisten: (() => void) | null = null;

export const useLink = create<LinkStore>((set, get) => ({
  state: 'disconnected',
  description: null,
  message: null,
  firmware: null,
  status: null,
  controller: null,
  job: null,
  loadedJob: null,
  jobText: null,
  lastAlarm: null,
  lastStatusAt: null,
  lastRxAt: null,
  queue: { pending: 0, inFlight: false },
  ports: [],
  portsLoading: false,
  connectedProfileId: null,

  async init() {
    if (unlisten) return;
    unlisten = await backend.onLinkEvent(handleEvent);
    try {
      const snap = await backend.snapshot();
      set({ state: snap.state, description: snap.description, firmware: snap.firmware, status: snap.status, controller: snap.controller ?? null, job: snap.job ?? null });
    } catch {
      /* first run */
    }
    await get().refreshPorts();
  },

  async refreshPorts() {
    set({ portsLoading: true });
    try {
      set({ ports: await backend.listPorts() });
    } catch (e) {
      sysMessage(`Could not list serial ports: ${errorMessage(e)}`, 'error');
    } finally {
      set({ portsLoading: false });
    }
  },

  async connect(port, profile, opts) {
    const settings = useApp.getState().settings.connection;
    set({ message: null, firmware: null, status: null, controller: null, job: null, lastAlarm: null, connectedProfileId: profile.id });
    const target =
      port === VIRTUAL_PORT
        ? { kind: 'virtual' as const, profile, flavor: opts?.flavor ?? settings.virtualFlavor, timeScale: opts?.timeScale ?? settings.virtualTimeScale }
        : { kind: 'serial' as const, path: port, baud: profile.controller.baudRate };
    sysMessage(port === VIRTUAL_PORT ? `Connecting to the virtual controller (${target.kind === 'virtual' ? target.flavor : ''})…` : `Connecting to ${port} at ${profile.controller.baudRate} baud…`);
    try {
      await backend.connect({
        target,
        pollHz: profile.controller.statusPollHz,
        autoReconnect: settings.autoReconnect,
        charCounting: profile.controller.streamingMode === 'character-counting',
        rxBuffer: profile.controller.rxBufferSize,
      });
      useApp.getState().update((s) => ({ ...s, connection: { ...s.connection, lastPort: port } }));
    } catch (e) {
      const msg = errorMessage(e);
      set({ state: 'disconnected', message: msg, connectedProfileId: null });
      sysMessage(`Connection failed: ${msg}`, 'error');
      throw e;
    }
  },

  async disconnect() {
    await backend.disconnect();
    set({ connectedProfileId: null });
  },

  async sendLine(line) {
    useConsole.getState().remember(line);
    await backend.sendLine(line);
  },

  async sendLines(lines) {
    for (const l of lines) await backend.sendLine(l);
  },

  async sendRealtime(byte) {
    await backend.sendRealtime(byte);
  },

  async refreshController() {
    await backend.controllerRefresh();
  },

  async openJob() {
    assertNoActiveJob(get().job);
    const r = await backend.openJob();
    if (r) acceptJob(r.job, r.text);
  },

  async loadJobPath(path) {
    assertNoActiveJob(get().job);
    const r = await backend.loadJobPath(path);
    acceptJob(r.job, r.text);
  },

  async loadJobText(name, text) {
    assertNoActiveJob(get().job);
    const job = await backend.loadJobText(name, text);
    acceptJob(job, text);
  },

  async unloadJob() {
    assertNoActiveJob(get().job);
    await backend.jobUnload();
    set({ loadedJob: null, jobText: null, job: null });
  },

  async startJob(mode, options) {
    await backend.jobStart(mode, options);
  },

  async toolChangeDone() {
    await backend.jobToolChangeDone();
  },
}));

function assertNoActiveJob(job: JobProgress | null) {
  if (job && isActivePhase(job.phase)) throw new Error('A job is running — stop it before loading another file.');
}

function acceptJob(job: LoadedJob, text: string) {
  useLink.setState({ loadedJob: job, jobText: text, job: null });
  sysMessage(`Loaded ${job.name}: ${job.scan.lines.toLocaleString()} lines to send.`);
  if (job.path) {
    useApp.getState().update((s) => ({ ...s, recentFiles: [job.path, ...s.recentFiles.filter((p) => p !== job.path)].slice(0, 10) }));
  }
}

function recordHistory(p: JobProgress) {
  if (p.phase !== 'completed' && p.phase !== 'stopped' && p.phase !== 'failed') return;
  const profileName = useProfilesName();
  useApp.getState().update((s) => ({
    ...s,
    jobHistory: [
      {
        name: p.name,
        mode: p.mode,
        outcome: p.phase as 'completed' | 'stopped' | 'failed',
        finishedAt: new Date().toISOString(),
        elapsedMs: p.elapsedMs,
        lines: p.total,
        errors: p.errorCount,
        message: p.message,
        profile: profileName,
      },
      ...s.jobHistory,
    ].slice(0, 50),
  }));
}

let profileNameGetter: () => string = () => '';
/** Set by the profiles store to avoid a circular import. */
export function setProfileNameGetter(f: () => string) {
  profileNameGetter = f;
}
function useProfilesName() {
  return profileNameGetter();
}

export function isActivePhase(phase: JobProgress['phase'] | undefined): boolean {
  return phase !== undefined && !['completed', 'stopped', 'failed'].includes(phase);
}

function handleEvent(e: LinkEvent) {
  commanderEvent(e);
  const set = useLink.setState;
  const push = useConsole.getState().push;
  switch (e.type) {
    case 'state': {
      set({ state: e.state, ...(e.description ? { description: e.description } : {}), message: e.message });
      if (e.state === 'disconnected') set({ status: null, firmware: null, description: null, controller: null, queue: { pending: 0, inFlight: false } });
      const label: Record<LinkState, string> = {
        connected: 'Connected',
        connecting: 'Connecting…',
        disconnected: 'Disconnected',
        lost: 'Connection lost',
        reconnecting: 'Reconnecting…',
      };
      const kind = e.state === 'lost' ? 'error' : e.state === 'reconnecting' ? 'warn' : 'info';
      push({ ts: Date.now(), dir: 'sys', text: `${label[e.state]}${e.description ? ` — ${e.description}` : ''}${e.message ? `. ${e.message}` : ''}`, kind });
      break;
    }
    case 'rx': {
      set({ lastRxAt: e.ts });
      let text = e.line;
      if (e.parsed.type === 'error') {
        const info = errorInfo(e.parsed.code);
        if (info) text = `${e.line} — ${info.title}: ${info.meaning}`;
      } else if (e.parsed.type === 'alarm') {
        const info = alarmInfo(e.parsed.code);
        if (info) text = `${e.line} — ${info.title}: ${info.meaning}`;
        set({ lastAlarm: { code: e.parsed.code, text: e.parsed.text, at: e.ts } });
      }
      push({ ts: e.ts, dir: 'rx', text, kind: e.parsed.type });
      break;
    }
    case 'tx':
      push({ ts: e.ts, dir: 'tx', text: e.line, kind: e.realtime ? 'realtime' : 'command' });
      break;
    case 'status': {
      const wasAlarm = useLink.getState().status?.state?.name === 'alarm';
      set({ status: e.status, lastStatusAt: e.ts, lastRxAt: e.ts });
      if (wasAlarm && e.status.state?.name !== 'alarm') set({ lastAlarm: null });
      break;
    }
    case 'firmware':
      set({ firmware: e.info });
      for (const w of e.info.warnings) push({ ts: Date.now(), dir: 'sys', text: w, kind: 'warn' });
      break;
    case 'queue':
      set({ queue: { pending: e.pending, inFlight: e.inFlight } });
      if (e.dropped > 0) push({ ts: Date.now(), dir: 'sys', text: `${e.dropped} command(s) were discarded (reset, alarm or disconnect). Nothing will be re-sent automatically.`, kind: 'warn' });
      break;
    case 'controller':
      set({ controller: e.info });
      setReportInches(e.info.settings['13'] === '1');
      break;
    case 'job': {
      const prev = useLink.getState().job;
      set({ job: e.progress });
      if (prev?.phase !== e.progress.phase) {
        const p = e.progress;
        const msg: Partial<Record<JobProgress['phase'], string>> = {
          running: `${p.mode === 'check' ? 'Check' : 'Job'} started: ${p.name}`,
          paused: 'Job paused.',
          'paused-on-error': `Job paused: line ${p.errors.at(-1)?.sourceLine ?? '?'} was rejected by the controller.`,
          stopping: 'Stopping job…',
          'tool-change': `Tool change at line ${p.toolChange?.line ?? '?'}${p.toolChange?.tool != null ? ` (T${p.toolChange.tool})` : ''}: the job is waiting for you.`,
          completed: p.message ?? 'Job finished.',
          stopped: p.message ?? 'Job stopped.',
          failed: p.message ?? 'Job failed.',
        };
        recordHistory(p);
        const text = msg[p.phase];
        if (text) push({ ts: Date.now(), dir: 'sys', text, kind: p.phase === 'failed' || p.phase === 'paused-on-error' ? 'error' : 'info' });
      }
      break;
    }
  }
}

/** True when the machine is (or may be) moving. */
export function isMotionState(s: MachineStatus | null): boolean {
  const n = s?.state?.name;
  return n === 'run' || n === 'jog' || n === 'home' || n === 'hold';
}
