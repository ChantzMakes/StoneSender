/**
 * Main-thread client for the G-code worker. A new analysis supersedes (and
 * terminates) one still running, so the UI never waits on stale work.
 */
import type { AnalyzeInput, AnalyzeResult } from './analyze';
import type { InterpState } from './interpreter';
import type { RenderGeometry } from './render';
import type { WorkerRequest, WorkerResponse } from './worker';

/** Worker result: the analysis plus the 3D view's render buffers. */
export type AnalysisResult = Omit<AnalyzeResult, 'checkpoints'> & { render: RenderGeometry };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (stage: string, f: number) => void }>();
let analyzeId: number | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') p.onProgress?.(m.stage, m.fraction);
    else {
      pending.delete(m.id);
      if (m.id === analyzeId) analyzeId = null;
      if (m.type === 'result') p.resolve(m.result);
      else p.reject(new Error(m.message));
    }
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'G-code worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function request<T>(msg: WorkerRequest, onProgress?: (stage: string, f: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage(msg);
  });
}

export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer analysis');
  }
}

export function analyzeInWorker(input: AnalyzeInput, onProgress?: (stage: string, fraction: number) => void): Promise<AnalysisResult> {
  if (analyzeId !== null && worker) {
    // Abandon the running analysis: restart the worker.
    const old = pending.get(analyzeId);
    pending.delete(analyzeId);
    old?.reject(new SupersededError());
    worker.terminate();
    worker = null;
    for (const p of pending.values()) p.reject(new SupersededError());
    pending.clear();
  }
  const id = nextId++;
  analyzeId = id;
  return request<AnalysisResult>({ type: 'analyze', id, input }, onProgress);
}

/** Modal state and position just before `line` of the last analysed job. */
export function stateBeforeLineInWorker(line: number): Promise<InterpState> {
  return request<InterpState>({ type: 'stateBefore', id: nextId++, line });
}
