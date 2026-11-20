/**
 * Stock + tool setup for the simulator, and where the work zero sits on the
 * machine. (Phase 6 extends this with a full tool library and removal sim.)
 */
import { machineBounds } from '@/lib/profile/geometry';
import type { MachineProfile } from '@/lib/profile/schema';

export type Vec3 = [number, number, number];

/** Where the work zero (X0 Y0 Z0) is on the stock */
export type StockOrigin = 'front-left-top' | 'center-top' | 'front-left-bottom';

export interface StockSetup {
  size: { x: number; y: number; z: number };
  origin: StockOrigin;
  color: string;
}

export interface ToolSetup {
  /** Cutter diameter, mm */
  diameter: number;
  /** Visible length below the collet, mm */
  stickout: number;
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export function defaultStock(p: MachineProfile): StockSetup {
  return { size: { ...p.defaults.stock.size }, origin: 'front-left-top', color: p.defaults.stock.color };
}

export function defaultTool(p: MachineProfile): ToolSetup {
  return p.machineType === 'laser' ? { diameter: 0.2, stickout: 0 } : { diameter: 6.35, stickout: 25 };
}

/** Stock box in work coordinates. */
export function stockBox(s: StockSetup): Box3 {
  const { x, y, z } = s.size;
  switch (s.origin) {
    case 'center-top':
      return { min: [-x / 2, -y / 2, -z], max: [x / 2, y / 2, 0] };
    case 'front-left-bottom':
      return { min: [0, 0, 0], max: [x, y, z] };
    default:
      return { min: [0, 0, -z], max: [x, y, 0] };
  }
}

/** Machine Z of the bed surface (lowest reach of the tool tip). */
export function bedZ(p: MachineProfile): number {
  return machineBounds(p).min.z;
}

/**
 * Work offset (machine position of work zero) to assume when not connected:
 * the stock lies on the bed near the front-left corner of the travel.
 */
export function assumedWco(p: MachineProfile, s: StockSetup): Vec3 {
  const b = machineBounds(p);
  const box = stockBox(s);
  const mx = Math.min(20, (b.max.x - b.min.x) * 0.05);
  const my = Math.min(20, (b.max.y - b.min.y) * 0.05);
  const stockMinMachine: Vec3 = [b.min.x + mx, b.min.y + my, bedZ(p)];
  return [stockMinMachine[0] - box.min[0], stockMinMachine[1] - box.min[1], stockMinMachine[2] - box.min[2]];
}
