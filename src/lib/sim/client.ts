/**
 * Main-thread client for the material-removal worker. `advance` is
 * latest-wins: while the worker is busy only the newest requested time is
 * kept, so fast scrubbing never queues up stale work.
 */
import type { Toolpath } from '@/lib/gcode/toolpath';
import type { Grid, RemovalConfig, SimEvent } from './removal';
import type { Patch, SimStats, SimWorkerRequest, SimWorkerResponse } from './sim.worker';

export type { Patch, SimStats };

export interface SimReady {
  grid: Grid;
  events: SimEvent[];
  stats: SimStats;
  initial: Patch;
}

export class SimClient {
  private worker: Worker;
  private id = 0;
  private busy = false;
  private pendingT: number | null = null;
  private initResolve: ((r: SimReady) => void) | null = null;
  private initReject: ((e: Error) => void) | null = null;
  private fullResolve: ((r: { data: Float32Array; flags: Uint8Array }) => void) | null = null;
  onPatch: (t: number, p: Patch | null) => void = () => {};
  onProgress: (f: number) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<SimWorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => this.initReject?.(new Error(e.message || 'simulation worker crashed'));
  }

  private send(m: SimWorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private handle(m: SimWorkerResponse) {
    if (m.id !== this.id && m.type !== 'patch' && m.type !== 'full') return;
    switch (m.type) {
      case 'progress':
        this.onProgress(m.fraction);
        break;
      case 'ready':
        this.initResolve?.({ grid: m.grid, events: m.events, stats: m.stats, initial: m.initial });
        this.initResolve = this.initReject = null;
        break;
      case 'patch':
        this.busy = false;
        this.onPatch(m.t, m.patch);
        if (this.pendingT !== null) {
          const t = this.pendingT;
          this.pendingT = null;
          this.advance(t);
        }
        break;
      case 'full':
        this.fullResolve?.({ data: m.data, flags: m.flags });
        this.fullResolve = null;
        break;
      case 'error':
        this.busy = false;
        this.initReject?.(new Error(m.message));
        this.initResolve = this.initReject = null;
        break;
    }
  }

  /** Run the whole job once (copies the toolpath: the analysis keeps its own). */
  init(tp: Toolpath, segEnd: Float64Array, cfg: RemovalConfig): Promise<SimReady> {
    this.id++;
    this.busy = false;
    this.pendingT = null;
    const copy = (a: ArrayBufferView & { slice(): typeof a }) => a.slice();
    const toolpath: Toolpath = {
      ...tp,
      origin: copy(tp.origin) as Float32Array,
      kind: copy(tp.kind) as Uint8Array,
      flags: copy(tp.flags) as Uint8Array,
      line: copy(tp.line) as Uint32Array,
      end: copy(tp.end) as Float32Array,
      feed: copy(tp.feed) as Float32Array,
      spindle: copy(tp.spindle) as Float32Array,
      tool: copy(tp.tool) as Uint16Array,
      arcRef: copy(tp.arcRef) as Int32Array,
      arcs: copy(tp.arcs) as Float32Array,
      duration: copy(tp.duration) as Float32Array,
      motion: copy(tp.motion) as Float32Array,
    };
    return new Promise((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      this.send({ type: 'init', id: this.id, toolpath, segEnd: segEnd.slice(), cfg });
    });
  }

  advance(t: number) {
    if (this.busy) {
      this.pendingT = t;
      return;
    }
    this.busy = true;
    this.send({ type: 'advance', id: this.id, t });
  }

  full(): Promise<{ data: Float32Array; flags: Uint8Array }> {
    return new Promise((resolve) => {
      this.fullResolve = resolve;
      this.send({ type: 'full', id: this.id });
    });
  }

  dispose() {
    this.worker.terminate();
  }
}
