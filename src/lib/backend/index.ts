import { browserBackend } from './browser';
import { tauriBackend } from './tauri';
import type { Backend } from './types';

export * from './types';

/** True inside the Tauri webview. */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const backend: Backend = isTauri ? tauriBackend : browserBackend;
