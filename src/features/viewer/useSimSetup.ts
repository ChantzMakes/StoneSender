/** Stock/tool for the simulator and the work offset used to place the machine. */
import { useEffect } from 'react';
import { assumedWco, defaultStock, defaultTool, type StockSetup, type ToolSetup, type Vec3 } from '@/lib/sim/setup';
import type { MachineProfile } from '@/lib/profile/schema';
import { useLink } from '@/store/link';
import { useSim } from '@/store/sim';

/** Reset stock/tool to the profile defaults when the profile changes. */
export function useSimSetup(profile: MachineProfile): { stock: StockSetup; tool: ToolSetup } {
  const stock = useSim((s) => s.stock);
  const tool = useSim((s) => s.tool);
  const setupFor = useSim((s) => s.setupFor);
  const key = `${profile.id}:${profile.updatedAt}`;
  useEffect(() => {
    if (setupFor !== key) useSim.setState({ stock: defaultStock(profile), tool: defaultTool(profile), setupFor: key });
  }, [key, setupFor, profile]);
  return { stock: stock ?? defaultStock(profile), tool: tool ?? defaultTool(profile) };
}

/** Machine position of work zero: the live WCO when connected, otherwise an assumed placement. */
export function useSimWco(profile: MachineProfile, stock: StockSetup): { wco: Vec3; assumed: boolean } {
  const connected = useLink((s) => s.state === 'connected');
  const wco = useLink((s) => s.status?.wco);
  if (connected && wco && wco.length >= 3) return { wco: [wco[0]!, wco[1]!, wco[2]!], assumed: false };
  return { wco: assumedWco(profile, stock), assumed: true };
}
