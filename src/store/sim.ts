/** 3D view + playback state (scrubber time, colours, camera requests, measuring). */
import { create } from 'zustand';
import type { StockSetup, ToolSetup } from '@/lib/sim/setup';

export type ColorMode = 'type' | 'feed' | 'z' | 'power';
export type ViewKind = 'top' | 'front' | 'side' | 'iso' | 'fit' | 'machine';
export type Vec3 = [number, number, number];

export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100] as const;

interface SimStore {
  /** Playback time (s) in preview mode */
  time: number;
  playing: boolean;
  speed: number;
  /** Source line at `time` (for the editor) */
  line: number;
  colorMode: ColorMode;
  showRapids: boolean;
  showGrid: boolean;
  showEnvelope: boolean;
  follow: boolean;
  measuring: boolean;
  measure: Vec3[];
  viewRequest: { kind: ViewKind; seq: number } | null;
  /** Stock and tool for the simulator (defaults come from the active profile) */
  stock: StockSetup | null;
  tool: ToolSetup | null;
  /** Profile the stock/tool defaults were taken from */
  setupFor: string | null;
  showMachine: boolean;
  showStock: boolean;
  setTime(t: number): void;
  setPlaying(p: boolean): void;
  set(p: Partial<Omit<SimStore, 'setTime' | 'setPlaying' | 'set' | 'requestView' | 'addMeasurePoint'>>): void;
  requestView(kind: ViewKind): void;
  addMeasurePoint(p: Vec3): void;
}

let seq = 0;

export const useSim = create<SimStore>((set, get) => ({
  time: 0,
  playing: false,
  speed: 1,
  line: 0,
  colorMode: 'type',
  showRapids: true,
  showGrid: true,
  showEnvelope: true,
  follow: false,
  measuring: false,
  measure: [],
  viewRequest: null,
  stock: null,
  tool: null,
  setupFor: null,
  showMachine: true,
  showStock: true,
  setTime: (t) => set({ time: Math.max(0, t) }),
  setPlaying: (p) => set({ playing: p }),
  set: (p) => set(p),
  requestView: (kind) => set({ viewRequest: { kind, seq: ++seq } }),
  addMeasurePoint: (p) => {
    const m = get().measure;
    set({ measure: m.length >= 2 ? [p] : [...m, p] });
  },
}));
