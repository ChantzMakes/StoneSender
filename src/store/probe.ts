/** Results kept between probing runs (this session only). */
import { create } from 'zustand';
import type { HeightMap } from '@/lib/gcode/level';

interface ProbeStore {
  /** Tool-setter reference: work Z the remembered bit had at the setter touch */
  setterRef: { workZ: number; at: number } | null;
  heightMap: (HeightMap & { at: number }) | null;
}

export const useProbe = create<ProbeStore>(() => ({ setterRef: null, heightMap: null }));
