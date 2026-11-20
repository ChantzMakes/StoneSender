/// <reference lib="webworker" />
/**
 * G-code analysis worker. Keeps the last job's text and checkpoints so
 * "state before line N" (start-from-line, Phase 7) is cheap.
 */
import { analyze, interpretOptions, type AnalyzeInput } from './analyze';
import { stateBeforeLine, type Checkpoint, type InterpretOptions } from './interpreter';
import { buildRenderGeometry, renderTransferables } from './render';
import { transferables } from './toolpath';

export type WorkerRequest = { type: 'analyze'; id: number; input: AnalyzeInput } | { type: 'stateBefore'; id: number; line: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };

let last: { text: string; checkpoints: Checkpoint[]; opts: InterpretOptions } | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') {
      let lastPost = 0;
      const result = analyze(msg.input, (stage, fraction) => {
        const now = performance.now();
        if (now - lastPost > 100) {
          lastPost = now;
          post({ type: 'progress', id: msg.id, stage, fraction });
        }
      });
      post({ type: 'progress', id: msg.id, stage: 'Preparing 3D view', fraction: 0 });
      const settings = msg.input.controllerSettings;
      const laser = settings?.['32'] !== undefined ? settings['32'] === '1' : msg.input.profile.machineType === 'laser';
      const render = buildRenderGeometry(result.toolpath, { laser });
      const { checkpoints, ...rest } = result;
      last = { text: msg.input.text, checkpoints, opts: interpretOptions(msg.input) };
      post({ type: 'result', id: msg.id, result: { ...rest, render } }, [...transferables(result.toolpath), result.lineEndTime.buffer as ArrayBuffer, ...renderTransferables(render)]);
    } else if (msg.type === 'stateBefore') {
      if (!last) throw new Error('no job analysed yet');
      post({ type: 'result', id: msg.id, result: stateBeforeLine(last.text, { checkpoints: last.checkpoints }, msg.line, last.opts) });
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
