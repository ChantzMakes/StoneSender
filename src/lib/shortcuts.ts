/**
 * Keyboard shortcuts (Phase 8): action registry, key names, user bindings.
 *
 * Owner decision ("STOP fixed + opt-in jog keys"):
 *  - Esc is always STOP while the machine moves; it can't be rebound or
 *    removed. A second STOP key may be added.
 *  - Jog keys work only while the session's "Keyboard jog" toggle is on (off
 *    at every start), only with the window focused, and stop on key release.
 *  - No shortcut starts a job, resumes from a hold, homes or zeroes.
 */

export type ShortcutGroup = 'Machine' | 'Jogging' | 'Files and views' | 'Help';

export interface ShortcutDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  defaultKey: string | null;
  /** Can't be changed (shown for reference) */
  fixed?: boolean;
  note?: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'stop', label: 'STOP (feed hold, then reset)', group: 'Machine', defaultKey: 'Escape', fixed: true, note: 'Only while the machine moves, so Esc still closes dialogs when idle.' },
  { id: 'stop.extra', label: 'STOP — second key', group: 'Machine', defaultKey: null, note: 'Works like Esc: only while the machine moves.' },
  { id: 'feedHold', label: 'Pause (feed hold)', group: 'Machine', defaultKey: null, note: 'Resuming is always a click.' },
  { id: 'jog.x+', label: 'Jog X+', group: 'Jogging', defaultKey: 'ArrowRight' },
  { id: 'jog.x-', label: 'Jog X−', group: 'Jogging', defaultKey: 'ArrowLeft' },
  { id: 'jog.y+', label: 'Jog Y+', group: 'Jogging', defaultKey: 'ArrowUp' },
  { id: 'jog.y-', label: 'Jog Y−', group: 'Jogging', defaultKey: 'ArrowDown' },
  { id: 'jog.z+', label: 'Jog Z+', group: 'Jogging', defaultKey: 'PageUp' },
  { id: 'jog.z-', label: 'Jog Z−', group: 'Jogging', defaultKey: 'PageDown' },
  { id: 'jog.stepUp', label: 'Bigger jog step', group: 'Jogging', defaultKey: ']' },
  { id: 'jog.stepDown', label: 'Smaller jog step', group: 'Jogging', defaultKey: '[' },
  { id: 'file.open', label: 'Open a G-code file', group: 'Files and views', defaultKey: 'Ctrl+O' },
  { id: 'view.toggle', label: 'Switch 3D view / G-code', group: 'Files and views', defaultKey: 'Ctrl+E' },
  { id: 'view.console', label: 'Show / hide the console', group: 'Files and views', defaultKey: 'Ctrl+J' },
  { id: 'preferences', label: 'Preferences', group: 'Help', defaultKey: 'Ctrl+,' },
  { id: 'help', label: 'Help', group: 'Help', defaultKey: 'F1' },
];

export const JOG_SHORTCUTS: Record<string, [number, number, number]> = {
  'jog.x+': [1, 0, 0],
  'jog.x-': [-1, 0, 0],
  'jog.y+': [0, 1, 0],
  'jog.y-': [0, -1, 0],
  'jog.z+': [0, 0, 1],
  'jog.z-': [0, 0, -1],
};

/** Keys that keep their normal meaning (navigation, dialogs, text editing). */
const RESERVED = new Set(['Escape', 'Tab', 'Shift+Tab', 'Enter', 'Space', 'Backspace', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y']);

const NAMED: Record<string, string> = { ' ': 'Space', Esc: 'Escape', Spacebar: 'Space', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };

/** Canonical name of a key press, e.g. "Ctrl+Shift+O", "F1", "ArrowUp", "]". Null for a lone modifier. */
export function keyName(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  let key = NAMED[e.key] ?? e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'Dead', 'Unidentified', 'Process'].includes(key)) return null;
  if (key.length === 1) key = key.toUpperCase();
  const mods: string[] = [];
  // Cmd on macOS counts as Ctrl so one binding works everywhere.
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift is part of printable characters ("?" vs "/"), so only name it for non-printing keys.
  if (e.shiftKey && key.length > 1) mods.push('Shift');
  return [...mods, key].join('+');
}

/** Human label: "Ctrl+," → "Ctrl + ,", "ArrowUp" → "↑". */
export function displayKey(k: string | null): string {
  if (!k) return '—';
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down' };
  const parts = k.split('+');
  // "Ctrl++" style names: the last part may be "+"
  if (k.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  return parts.map((p) => arrows[p] ?? p).join(' + ');
}

/** Current bindings: defaults with the user's overrides (null = unbound). */
export function bindings(overrides: Record<string, string | null>): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const s of SHORTCUTS) m.set(s.id, s.fixed ? s.defaultKey : s.id in overrides ? overrides[s.id]! : s.defaultKey);
  return m;
}

/** Action bound to a key (first match), or undefined. */
export function actionFor(key: string, overrides: Record<string, string | null>): string | undefined {
  for (const [id, k] of bindings(overrides)) if (k === key) return id;
  return undefined;
}

/** Why `key` can't be bound to `id`, or null if it can. */
export function bindingProblem(id: string, key: string, overrides: Record<string, string | null>): string | null {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) return 'unknown action';
  if (def.fixed) return 'this shortcut is fixed';
  if (RESERVED.has(key)) return key === 'Escape' ? 'Esc is always STOP' : `${displayKey(key)} keeps its usual meaning`;
  // Jog keys must be single keys: holding a modifier while jogging is error-prone.
  if (JOG_SHORTCUTS[id] && key.includes('+') && key !== '+') return 'jog keys can’t use Ctrl or Alt';
  for (const [other, k] of bindings(overrides)) {
    if (other !== id && k === key) return `already used for “${SHORTCUTS.find((s) => s.id === other)!.label}”`;
  }
  return null;
}
