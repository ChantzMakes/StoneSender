/** Editor → 3D view: jump playback to the start of a line (not during a live job). Kept free of three.js imports. */
import { timeAtLineStart } from '@/lib/gcode/render';
import { useAnalysis } from '@/store/analysis';
import { isActivePhase, useLink } from '@/store/link';
import { useSim } from '@/store/sim';

export function seekToLine(line: number) {
  const result = useAnalysis.getState().result;
  const job = useLink.getState().job;
  if (!result || (isActivePhase(job?.phase) && job?.mode === 'run')) return;
  useSim.setState({ playing: false, time: timeAtLineStart(result.lineEndTime, line), line });
}
