/** Which global dialogs are open (so banners and toolbar can open them). */
import { create } from 'zustand';

interface UiStore {
  settingsOpen: boolean;
  settingsTab: 'controller' | 'compare';
  wcsOpen: boolean;
  openSettings(tab?: 'controller' | 'compare'): void;
  closeSettings(): void;
  setWcsOpen(open: boolean): void;
}

export const useUi = create<UiStore>((set) => ({
  settingsOpen: false,
  settingsTab: 'controller',
  wcsOpen: false,
  openSettings: (tab = 'controller') => set({ settingsOpen: true, settingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
  setWcsOpen: (open) => set({ wcsOpen: open }),
}));
