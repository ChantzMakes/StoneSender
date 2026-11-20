/** MachineIO over the real link: tracked commands, probe results and the status WCO. */
import { useLink } from '@/store/link';
import { probeAndWait, readParserState, sendAndWait } from './commander';
import type { MachineIO, V3 } from './routines';

export function liveIO(signal: AbortSignal, step?: (text: string) => void): MachineIO {
  return {
    send: (line) => sendAndWait(line, signal),
    probe: (line) => probeAndWait(line, signal),
    parserState: () => readParserState(signal),
    workOffset: (): V3 => {
      const w = useLink.getState().status?.wco;
      return [w?.[0] ?? 0, w?.[1] ?? 0, w?.[2] ?? 0];
    },
    step,
  };
}
