/** Stock/tool for the simulator and the work offset used to place the machine. */
import { useEffect, useMemo } from 'react';
import { assumedWco, defaultStock, defaultTool, type StockSetup, type ToolSetup, type Vec3 } from '@/lib/sim/setup';
import type { MachineProfile } from '@/lib/profile/schema';
import { resolveTool } from '@/lib/sim/tools';
import { useAnalysis } from '@/store/analysis';
import { useApp } from '@/store/app';
import { useLink } from '@/store/link';
import { useSim } from '@/store/sim';

/** Reset stock and tool assignments to the profile defaults when the profile changes. */
export function useSimSetup(profile: MachineProfile): { stock: StockSetup; tool: ToolSetup } {
  const stock = useSim((s) => s.stock);
  const setupFor = useSim((s) => s.setupFor);
  const tool = useSimTool(profile);
  const key = `${profile.id}:${profile.updatedAt}`;
  useEffect(() => {
    if (setupFor !== key) useSim.setState({ stock: defaultStock(profile), jobTools: {}, defaultToolId: null, setupFor: key });
  }, [key, setupFor, profile]);
  return { stock: stock ?? defaultStock(profile), tool };
}

/**
 * Cutter used by the collision checks and drawn in the machine model: the
 * library tool for the job's first T number (or the default tool).
 */
export function useSimTool(profile: MachineProfile): ToolSetup {
  const tools = useApp((s) => s.settings.tools);
  const jobTools = useSim((s) => s.jobTools);
  const defaultToolId = useSim((s) => s.defaultToolId);
  const first = useAnalysis((s) => s.result?.stats.tools[0]?.tool ?? 0);
  const t = profile.machineType === 'laser' ? undefined : resolveTool(first, tools, jobTools, defaultToolId);
  const fallback = defaultTool(profile);
  const diameter = t?.diameter ?? fallback.diameter;
  const stickout = t?.stickout ?? fallback.stickout;
  // stable object so memoised checks / layouts only re-run on a real change
  return useMemo(() => ({ diameter, stickout }), [diameter, stickout]);
}

/** Machine position of work zero: the live WCO when connected, otherwise an assumed placement. */
export function useSimWco(profile: MachineProfile, stock: StockSetup): { wco: Vec3; assumed: boolean } {
  const connected = useLink((s) => s.state === 'connected');
  const wco = useLink((s) => s.status?.wco);
  if (connected && wco && wco.length >= 3) return { wco: [wco[0]!, wco[1]!, wco[2]!], assumed: false };
  return { wco: assumedWco(profile, stock), assumed: true };
}
