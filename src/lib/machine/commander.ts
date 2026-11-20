/**
 * Send a line and wait for *its* answer. Probing, tool changes and other
 * routines need each step acknowledged before the next one is decided; the
 * console and buttons keep using fire-and-forget `sendLine`.
 *
 * Uses tracked commands: the backend reports `commandAck { id }` for each
 * one, or `dropped` when a reset / alarm / disconnect discarded it.
 */
import { backend, type LinkEvent } from '@/lib/backend';
import { errorInfo } from '@/lib/grbl/codes';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly line: string,
    readonly code: number | null = null,
    readonly dropped = false,
  ) {
    super(message);
  }
}

export class AbortedError extends Error {
  constructor(message = 'Stopped.') {
    super(message);
  }
}

export interface ProbeHit {
  /** Machine coordinates (mm) where the probe triggered */
  position: [number, number, number];
}

interface Pending {
  line: string;
  resolve(): void;
  reject(e: Error): void;
}

let nextId = 1;
const pending = new Map<number, Pending>();
/** Last [PRB:] result and a counter so a routine knows it is new */
let probe: { position: number[]; success: boolean; seq: number } | null = null;
let probeSeq = 0;
/** Last `$G` answer */
let parserState: string[] | null = null;
/** $13=1 reports in inches */
let reportInches = false;

export function setReportInches(on: boolean) {
  reportInches = on;
}

/** Feed link events in (called from the link store). */
export function onLinkEvent(e: LinkEvent) {
  if (e.type === 'commandAck') {
    const p = pending.get(e.id);
    if (!p) return;
    pending.delete(e.id);
    if (e.dropped) p.reject(new CommandError('The controller reset or alarmed before this step ran — nothing more was sent.', p.line, null, true));
    else if (e.error !== null) {
      const info = errorInfo(e.error);
      p.reject(new CommandError(`The controller rejected “${p.line}” (error:${e.error}${info ? ` — ${info.title}` : ''}).`, p.line, e.error));
    } else p.resolve();
  } else if (e.type === 'rx' && e.parsed.type === 'probe') {
    const k = reportInches ? 25.4 : 1;
    probe = { position: e.parsed.position.map((v) => v * k), success: e.parsed.success, seq: ++probeSeq };
  } else if (e.type === 'rx' && e.parsed.type === 'parserState') {
    parserState = e.parsed.words;
  } else if (e.type === 'rx' && e.parsed.type === 'alarm') {
    abortAll(new CommandError(`ALARM:${e.parsed.code ?? '?'} — the controller stopped. Nothing more was sent.`, '', null, true));
  } else if (e.type === 'state' && e.state !== 'connected') {
    abortAll(new CommandError('The connection was lost. Nothing more was sent.', '', null, true));
  }
}

/** Reject everything that is still waiting (STOP, alarm, disconnect). */
export function abortAll(err: Error = new AbortedError()) {
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(err);
  }
}

/** Send one line and resolve when the controller answers `ok`. */
export function sendAndWait(line: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedError());
  const id = nextId++;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      if (pending.delete(id)) reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      line,
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    });
    backend.sendTracked(line, id).catch((e: unknown) => {
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/**
 * Send a G38.x line and return where the probe triggered. Rejects if the
 * probe did not trigger (G38.3/.5 report success = 0; G38.2/.4 alarm).
 */
export async function probeAndWait(line: string, signal?: AbortSignal): Promise<ProbeHit> {
  const before = probeSeq;
  await sendAndWait(line, signal);
  if (!probe || probe.seq === before) throw new CommandError('The controller did not report a probe result.', line);
  if (!probe.success) throw new CommandError('The probe did not touch anything within the maximum distance.', line);
  const [x = 0, y = 0, z = 0] = probe.position;
  return { position: [x, y, z] };
}

/** Ask the controller for its modal state (`$G`) and return the words. */
export async function readParserState(signal?: AbortSignal): Promise<string[]> {
  parserState = null;
  await sendAndWait('$G', signal);
  return parserState ?? [];
}

/** Number of commands still waiting (tests / diagnostics). */
export function pendingCount(): number {
  return pending.size;
}
