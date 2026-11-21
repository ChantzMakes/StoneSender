/** App-wide preferences, persisted via the backend (app-settings.json). */
import { z } from 'zod';
import { defaultMacros, MacroSchema } from '@/lib/macros';
import { create } from 'zustand';
import { backend } from '@/lib/backend';
import { defaultTools, ToolSchema } from '@/lib/sim/tools';
import { useEffect, useState } from 'react';
import { applyTheme as applyThemeChoice, DEFAULT_LAYOUT, prefersDark, themeBase } from '@/lib/theme';

const AppSettingsSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.enum(['system', 'dark', 'light', 'contrast']).default('dark'),
  /** Whole-UI zoom (root font size) */
  uiScale: z.number().min(0.75).max(2).default(1),
  /** Panel layout (Phase 8) */
  layout: z
    .object({
      preset: z.enum(['standard', 'running', 'setup', 'touch', 'custom']).default('standard'),
      show: z
        .object({
          machine: z.boolean().default(true),
          overrides: z.boolean().default(true),
          job: z.boolean().default(true),
          jog: z.boolean().default(true),
          macros: z.boolean().default(true),
          console: z.boolean().default(true),
        })
        .default({}),
      swapSides: z.boolean().default(false),
    })
    .default(DEFAULT_LAYOUT),
  /** Look for a new version on github.com when the app starts (Phase 8b) */
  updates: z.object({ checkOnStartup: z.boolean().default(true) }).default({}),
  /** Keyboard shortcut overrides: action id → key name, or null for none (lib/shortcuts.ts) */
  shortcuts: z.record(z.string(), z.string().nullable()).default({}),
  activeProfileId: z.string().nullable().default(null),
  wizardCompleted: z.boolean().default(false),
  console: z
    .object({
      hideStatus: z.boolean().default(true),
      hideOk: z.boolean().default(false),
      showTx: z.boolean().default(true),
    })
    .default({}),
  connection: z
    .object({
      lastPort: z.string().nullable().default(null),
      virtualFlavor: z.enum(['grbl11', 'grbl09', 'grblhal']).default('grbl11'),
      virtualTimeScale: z.number().min(0.1).max(100).default(1),
      autoReconnect: z.boolean().default(true),
    })
    .default({}),
  devTools: z.boolean().default(false),
  /** Most recent first; desktop file paths */
  recentFiles: z.array(z.string()).default([]),
  /** Most recent first */
  jobHistory: z
    .array(
      z.object({
        name: z.string(),
        mode: z.enum(['run', 'check']),
        outcome: z.enum(['completed', 'stopped', 'failed']),
        finishedAt: z.string(),
        elapsedMs: z.number(),
        lines: z.number(),
        errors: z.number(),
        message: z.string().nullable(),
        profile: z.string(),
      }),
    )
    .default([]),
  centerTab: z.enum(['view', 'editor']).default('view'),
  /** Tool library (shared across profiles) */
  tools: z.array(ToolSchema).default(() => defaultTools()),
  /** Simulation grid resolution in mm (0 = automatic) */
  simResolution: z.number().min(0).max(5).default(0),
  /** Macro buttons (Phase 7b) */
  macros: z.array(MacroSchema).default(() => defaultMacros()),
  /** Gamepad jogging (Phase 7b) */
  gamepad: z
    .object({
      enabled: z.boolean().default(true),
      /** Button index that must be held to jog (4 = LB, 5 = RB on standard mapping) */
      enableButton: z.number().int().min(0).max(16).default(4),
      deadzone: z.number().min(0.05).max(0.6).default(0.2),
    })
    .default({}),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({});

interface AppStore {
  loaded: boolean;
  settings: AppSettings;
  load(): Promise<void>;
  update(patch: (s: AppSettings) => AppSettings): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppStore>((set, get) => ({
  loaded: false,
  settings: DEFAULT_SETTINGS,
  async load() {
    let raw: unknown = null;
    try {
      raw = await backend.loadAppSettings();
    } catch (e) {
      console.warn('could not load app settings', e);
    }
    const parsed = AppSettingsSchema.safeParse(raw ?? {});
    set({ loaded: true, settings: parsed.success ? parsed.data : DEFAULT_SETTINGS });
    applyTheme(get().settings);
    // "Same as the computer" follows OS changes while the app runs.
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(get().settings));
  },
  update(patch) {
    const next = patch(get().settings);
    set({ settings: next });
    applyTheme(next);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      backend.saveAppSettings(get().settings).catch((e) => console.warn('could not save app settings', e));
    }, 250);
  },
}));

export function applyTheme(s: Pick<AppSettings, 'theme' | 'uiScale'>) {
  applyThemeChoice(s.theme, s.uiScale);
}

/** Resolved theme for canvases that pick their own colours (3D view, editor). */
export function useResolvedTheme(): 'dark' | 'light' | 'contrast' {
  const choice = useApp((s) => s.settings.theme);
  const [systemDark, setSystemDark] = useState(prefersDark);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return choice === 'contrast' ? 'contrast' : themeBase(choice, systemDark);
}
