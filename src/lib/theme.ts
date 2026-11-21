/**
 * Themes and layouts (Phase 8). Pure helpers; the app store applies them.
 */

export type ThemeChoice = 'system' | 'dark' | 'light' | 'contrast';
/** What the 3D view and the editor need: a dark or a light palette */
export type ThemeBase = 'dark' | 'light';

export const THEMES: { value: ThemeChoice; label: string; description: string }[] = [
  { value: 'system', label: 'Same as the computer', description: 'Follows the light / dark setting of your operating system.' },
  { value: 'dark', label: 'Dark', description: 'Easy on the eyes in a dim shop.' },
  { value: 'light', label: 'Light', description: 'Best in bright rooms.' },
  { value: 'contrast', label: 'High contrast', description: 'Black background, bold colours and borders — readable from a distance and in direct light.' },
];

export function prefersDark(): boolean {
  return typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function themeBase(choice: ThemeChoice, systemDark = prefersDark()): ThemeBase {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice === 'light' ? 'light' : 'dark';
}

export const UI_SCALES = [0.875, 1, 1.125, 1.25, 1.5] as const;

export function applyTheme(choice: ThemeChoice, scale: number) {
  if (typeof document === 'undefined') return;
  const base = themeBase(choice);
  const root = document.documentElement;
  root.classList.toggle('dark', base === 'dark');
  root.classList.toggle('contrast', choice === 'contrast');
  root.dataset.theme = choice === 'contrast' ? 'contrast' : base;
  // Everything is sized in rem, so the root font size scales the whole UI.
  root.style.fontSize = scale === 1 ? '' : `${16 * scale}px`;
}

// ---------------------------------------------------------------------------
// Layouts

export interface PanelVisibility {
  machine: boolean;
  overrides: boolean;
  job: boolean;
  jog: boolean;
  macros: boolean;
  console: boolean;
}

export interface LayoutSettings {
  preset: LayoutPreset;
  show: PanelVisibility;
  /** Job / jog column on the left, position / controls on the right */
  swapSides: boolean;
}

export type LayoutPreset = 'standard' | 'running' | 'setup' | 'touch' | 'custom';

export const PANEL_LABELS: Record<keyof PanelVisibility, string> = {
  machine: 'Machine controls (home, zero, probe…)',
  overrides: 'Feed / spindle overrides',
  job: 'Job',
  jog: 'Jogging',
  macros: 'Macros',
  console: 'Console',
};

const ALL: PanelVisibility = { machine: true, overrides: true, job: true, jog: true, macros: true, console: true };

export const LAYOUT_PRESETS: { value: Exclude<LayoutPreset, 'custom'>; label: string; description: string; show: PanelVisibility; scale?: number }[] = [
  { value: 'standard', label: 'Standard', description: 'Everything visible.', show: ALL },
  { value: 'running', label: 'Running a job', description: 'Big 3D view, job and overrides; jogging and macros hidden.', show: { ...ALL, jog: false, macros: false, console: false } },
  { value: 'setup', label: 'Setting up', description: 'Jogging, zeroing, probing and macros; overrides hidden.', show: { ...ALL, overrides: false } },
  { value: 'touch', label: 'Touch screen', description: 'Larger controls (125 %) and no console.', show: { ...ALL, console: false }, scale: 1.25 },
];

export const DEFAULT_LAYOUT: LayoutSettings = { preset: 'standard', show: ALL, swapSides: false };
