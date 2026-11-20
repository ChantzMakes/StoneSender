/** App-wide preferences, persisted via the backend (app-settings.json). */
import { z } from 'zod';
import { create } from 'zustand';
import { backend } from '@/lib/backend';

const AppSettingsSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.enum(['dark', 'light']).default('dark'),
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
    applyTheme(get().settings.theme);
  },
  update(patch) {
    const next = patch(get().settings);
    set({ settings: next });
    applyTheme(next.theme);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      backend.saveAppSettings(get().settings).catch((e) => console.warn('could not save app settings', e));
    }, 250);
  },
}));

export function applyTheme(theme: 'dark' | 'light') {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
}
