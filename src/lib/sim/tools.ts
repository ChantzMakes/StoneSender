/**
 * Tool library: shapes the material-removal simulator understands.
 *
 * A tool's *profile* is the height of its cutting surface above the tip at a
 * radial distance d from the axis (Infinity outside the cutter).
 */
import { z } from 'zod';

export const ToolKindSchema = z.enum(['flat', 'ball', 'vbit', 'engraver', 'drill']);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const ToolSchema = z.object({
  id: z.string().min(1),
  /** T number in G-code */
  number: z.number().int().min(0).max(255),
  name: z.string().min(1).max(60),
  kind: ToolKindSchema,
  /** Cutting diameter (mm) */
  diameter: z.number().positive().max(100),
  /** Length of the cutting flutes (mm) */
  fluteLength: z.number().positive().max(300),
  /** Length from collet / holder face to the tip (mm) */
  stickout: z.number().positive().max(400),
  /** Included angle for V-bits, engravers, drills (degrees) */
  angle: z.number().min(5).max(179).default(90),
  /** Flat tip diameter for engravers (mm) */
  tipDiameter: z.number().min(0).max(20).default(0),
  /** Diameter of the collet nut / holder (mm) — for clearance checks */
  holderDiameter: z.number().positive().max(200).default(22),
});
export type Tool = z.infer<typeof ToolSchema>;

export const TOOL_KIND_LABEL: Record<ToolKind, string> = {
  flat: 'Flat end mill',
  ball: 'Ball end mill',
  vbit: 'V-bit',
  engraver: 'Engraving bit (flat tip)',
  drill: 'Drill',
};

let seq = 0;
export function toolId(): string {
  return `tool-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

export function defaultTools(): Tool[] {
  const t = (number: number, name: string, kind: ToolKind, diameter: number, fluteLength: number, stickout: number, extra: Partial<Tool> = {}): Tool =>
    ToolSchema.parse({ id: `default-${number}`, number, name, kind, diameter, fluteLength, stickout, ...extra });
  return [
    t(1, '1/4" flat end mill', 'flat', 6.35, 22, 30),
    t(2, '1/8" flat end mill', 'flat', 3.175, 12, 20),
    t(3, '6 mm ball nose', 'ball', 6, 20, 30),
    t(4, '60° V-bit', 'vbit', 12.7, 11, 25, { angle: 60 }),
    t(5, '90° V-bit', 'vbit', 12.7, 6.4, 25, { angle: 90 }),
    t(6, '30° engraver, 0.2 mm tip', 'engraver', 3.175, 5, 18, { angle: 30, tipDiameter: 0.2 }),
    t(7, '3 mm drill', 'drill', 3, 30, 40, { angle: 118 }),
  ];
}

/** Height of the cutting surface above the tip at radial distance d. */
export function toolProfile(tool: Pick<Tool, 'kind' | 'diameter' | 'angle' | 'tipDiameter'>): (d: number) => number {
  const R = tool.diameter / 2;
  const tanHalf = Math.tan(((tool.angle ?? 90) * Math.PI) / 360);
  switch (tool.kind) {
    case 'ball':
      return (d) => (d > R ? Infinity : R - Math.sqrt(Math.max(R * R - d * d, 0)));
    case 'vbit':
    case 'drill':
      return (d) => (d > R ? Infinity : d / tanHalf);
    case 'engraver': {
      const tip = (tool.tipDiameter ?? 0) / 2;
      return (d) => (d > R ? Infinity : d <= tip ? 0 : (d - tip) / tanHalf);
    }
    default:
      return (d) => (d > R ? Infinity : 0);
  }
}

/** Cutting width at a given depth below the tip (for V shapes this grows with depth). */
export function widthAtDepth(tool: Tool, depth: number): number {
  const p = toolProfile(tool);
  const R = tool.diameter / 2;
  let lo = 0;
  let hi = R;
  if (p(R) <= depth) return tool.diameter;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (p(mid) <= depth) lo = mid;
    else hi = mid;
  }
  return 2 * lo;
}

/**
 * Library tool for a job's T number: the explicit assignment, else the library
 * tool with that number, else the default tool, else the first tool.
 */
export function resolveTool(t: number, tools: Tool[], jobTools: Record<number, string>, defaultToolId: string | null): Tool | undefined {
  const id = jobTools[t];
  return (id ? tools.find((x) => x.id === id) : undefined) ?? (t > 0 ? tools.find((x) => x.number === t) : undefined) ?? tools.find((x) => x.id === defaultToolId) ?? tools[0];
}
