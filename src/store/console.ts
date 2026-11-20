import { create } from 'zustand';
import type { GrblLine } from '@/lib/backend';

export interface ConsoleEntry {
  id: number;
  ts: number;
  dir: 'rx' | 'tx' | 'sys';
  text: string;
  kind: GrblLine['type'] | 'realtime' | 'command' | 'info' | 'warn' | 'error';
}

const MAX_ENTRIES = 3000;
const MAX_HISTORY = 100;

interface ConsoleStore {
  entries: ConsoleEntry[];
  history: string[];
  push(e: Omit<ConsoleEntry, 'id'>): void;
  clear(): void;
  remember(cmd: string): void;
}

let nextId = 1;

export const useConsole = create<ConsoleStore>((set) => ({
  entries: [],
  history: [],
  push(e) {
    set((s) => {
      const entries = s.entries.length >= MAX_ENTRIES ? s.entries.slice(s.entries.length - MAX_ENTRIES + 1) : s.entries.slice();
      entries.push({ ...e, id: nextId++ });
      return { entries };
    });
  },
  clear() {
    set({ entries: [] });
  },
  remember(cmd) {
    set((s) => ({ history: [cmd, ...s.history.filter((h) => h !== cmd)].slice(0, MAX_HISTORY) }));
  },
}));

export function sysMessage(text: string, kind: ConsoleEntry['kind'] = 'info') {
  useConsole.getState().push({ ts: Date.now(), dir: 'sys', text, kind });
}
