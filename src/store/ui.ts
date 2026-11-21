/** Which global dialogs are open (so banners, toolbar and shortcuts can open them). */
import { create } from 'zustand';

export type PrefsTab = 'appearance' | 'layout' | 'shortcuts' | 'gamepad' | 'advanced' | 'about';

interface UiStore {
  settingsOpen: boolean;
  settingsTab: 'controller' | 'compare';
  wcsOpen: boolean;
  /** Help dialog: open, and the section to show */
  help: { open: boolean; section: string | null };
  prefs: { open: boolean; tab: PrefsTab };
  /**
   * Keyboard jogging (owner decision): off at every start, on only while this
   * session toggle is on. Deliberately not saved in the settings file.
   */
  keyboardJog: boolean;
  /** Bumped to remount the panel layout with default sizes */
  layoutEpoch: number;
  openSettings(tab?: 'controller' | 'compare'): void;
  closeSettings(): void;
  setWcsOpen(open: boolean): void;
  openHelp(section?: string | null): void;
  closeHelp(): void;
  openPrefs(tab?: PrefsTab): void;
  closePrefs(): void;
  setKeyboardJog(on: boolean): void;
  resetLayoutSizes(): void;
}

export const useUi = create<UiStore>((set) => ({
  settingsOpen: false,
  settingsTab: 'controller',
  wcsOpen: false,
  help: { open: false, section: null },
  prefs: { open: false, tab: 'appearance' },
  keyboardJog: false,
  layoutEpoch: 0,
  openSettings: (tab = 'controller') => set({ settingsOpen: true, settingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  setWcsOpen: (open) => set({ wcsOpen: open }),
  openHelp: (section = null) => set({ help: { open: true, section } }),
  closeHelp: () => set((s) => ({ help: { ...s.help, open: false } })),
  openPrefs: (tab = 'appearance') => set({ prefs: { open: true, tab } }),
  closePrefs: () => set((s) => ({ prefs: { ...s.prefs, open: false } })),
  setKeyboardJog: (on) => set({ keyboardJog: on }),
  resetLayoutSizes: () => {
    // react-resizable-panels keeps sizes in localStorage under its autoSaveId
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('react-resizable-panels:')) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
    set((s) => ({ layoutEpoch: s.layoutEpoch + 1 }));
  },
}));
