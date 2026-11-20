/**
 * Guided tool change (spec §5): shown while a job waits at an M6. Follows the
 * profile's strategy:
 *  - pause:         go to the change position, change the bit, continue
 *  - pause-reprobe: … then touch-plate Z on the surface Z was zeroed on
 *  - tool-setter:   measure the old bit on the setter, change, measure the
 *                   new one; work Z shifts by the length difference
 * The spindle is stopped first and restored (with spin-up) from the job's
 * own state before the job continues. Every move waits for the controller.
 */
import { Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { backend } from '@/lib/backend';
import { stateBeforeLineInWorker } from '@/lib/gcode/client';
import { liveIO } from '@/lib/machine/liveIO';
import { applyToolLengthChange, goToToolChange, measureOnToolSetter, probeSettings, probeZPlate, resumeAfterToolChange } from '@/lib/machine/routines';
import type { MachineProfile } from '@/lib/profile/schema';
import { resolveTool } from '@/lib/sim/tools';
import { errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { useLink } from '@/store/link';
import { useSim } from '@/store/sim';
import { TouchTest, useTouchTest } from '../probe/TouchTest';

type Stage = 'start' | 'change' | 'measure' | 'ready';

export function ToolChangePanel({ profile }: { profile: MachineProfile }) {
  const tc = useLink((s) => s.job?.toolChange);
  const tools = useApp((s) => s.settings.tools);
  const jobTools = useSim((s) => s.jobTools);
  const defaultToolId = useSim((s) => s.defaultToolId);
  const strategy = profile.toolChange.strategy;
  const [stage, setStage] = useState<Stage>('start');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitted, setFitted] = useState(false);
  const oldTool = useRef<{ machineZ: number; workZ: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const touch = useTouchTest(stage === 'measure' || (stage === 'start' && strategy === 'tool-setter'));
  const key = tc?.line;

  useEffect(() => {
    setStage('start');
    setFitted(false);
    setError(null);
    oldTool.current = null;
    touch.reset();
  }, [key]);
  useEffect(() => () => abort.current?.abort(), []);

  if (!tc) return null;
  const lib = tc.tool != null ? resolveTool(tc.tool, tools, jobTools, defaultToolId) : undefined;
  const s = probeSettings(profile);

  const run = async (label: string, f: (io: ReturnType<typeof liveIO>) => Promise<void>, next?: Stage) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setError(null);
    setStep(label);
    try {
      await f(liveIO(ac.signal, setStep));
      if (next) setStage(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const toChange = () =>
    run(
      'Moving to the tool-change position…',
      async (io) => {
        if (strategy === 'tool-setter') oldTool.current = await measureOnToolSetter(io, s, profile);
        await goToToolChange(io, profile);
      },
      'change',
    );

  const measure = () =>
    run(
      'Measuring the new bit…',
      async (io) => {
        if (strategy === 'tool-setter') {
          if (!oldTool.current) throw new Error('The old bit was not measured.');
          const now = await measureOnToolSetter(io, s, profile);
          await applyToolLengthChange(io, now.machineZ, oldTool.current.workZ, profile);
        } else {
          await probeZPlate(io, s, profile.probe.plateThickness);
        }
      },
      'ready',
    );

  const resume = () =>
    run('Restarting…', async (io) => {
      // The spindle / coolant the job expects right after the M6 line.
      const st = await stateBeforeLineInWorker(tc.line + 1);
      await resumeAfterToolChange(io, profile, { cmd: st.modal.spindle, speed: st.modal.speed }, st.modal.coolant);
      await useLink.getState().toolChangeDone();
      sysMessage(`Tool change done; job continues after line ${tc.line}.`);
    });

  const needsMeasure = strategy === 'pause-reprobe' || strategy === 'tool-setter';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="tool-change-panel">
      <div className="font-semibold">
        Tool change — line {tc.line}
        {tc.tool != null ? `: T${tc.tool}` : ''}
        {lib ? ` (${lib.name})` : ''}
      </div>
      {stage === 'start' && (
        <>
          <p>
            Everything before the M6 has finished. {strategy === 'tool-setter' ? 'The current bit is measured on the tool setter first, then ' : ''}The spindle stops and the machine goes to the tool-change position.
          </p>
          {strategy === 'tool-setter' && <TouchTest test={touch} what="the tool setter button" />}
          <Button disabled={busy || (strategy === 'tool-setter' && !touch.passed)} onClick={() => void toChange()} data-testid="tc-go">
            {strategy === 'tool-setter' ? 'Measure this bit, then go to the change position' : 'Go to the tool-change position'}
          </Button>
        </>
      )}
      {stage === 'change' && (
        <>
          <p>
            The spindle is off. Change the bit{lib ? ` to ${lib.name}` : ''} now, with the spindle stopped{profile.spindle.maxRpm > 0 ? ' — switch it off at its controller too if you can' : ''}.
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={fitted} onChange={(e) => setFitted(e.target.checked)} data-testid="tc-fitted" />
            The new bit is fitted and the collet is tight.
          </label>
          <Button disabled={!fitted} onClick={() => setStage(needsMeasure ? 'measure' : 'ready')} data-testid="tc-next">
            Next
          </Button>
        </>
      )}
      {stage === 'measure' && (
        <>
          {strategy === 'tool-setter' ? (
            <p>The new bit is measured on the tool setter and work Z is shifted by the length difference, so Z0 stays where it was.</p>
          ) : (
            <p>
              Put the touch plate on the surface you set Z zero on (plate {profile.probe.plateThickness} mm), attach the clip and jog the bit over the plate, a few mm above it.
            </p>
          )}
          <TouchTest test={touch} what={strategy === 'tool-setter' ? 'the tool setter button' : 'the touch plate to the bit'} />
          <Button disabled={busy || !touch.passed} onClick={() => void measure()} data-testid="tc-measure">
            {strategy === 'tool-setter' ? 'Measure the new bit' : 'Probe Z'}
          </Button>
        </>
      )}
      {stage === 'ready' && (
        <>
          <p>
            {needsMeasure ? 'Z is set for the new bit. ' : 'Make sure Z zero is still right for the new bit (re-zero it with the jog panel or a probe if it is longer or shorter). '}
            {strategy === 'pause-reprobe' ? 'Remove the touch plate and clip. ' : ''}Continuing raises Z, restarts the spindle as the job had it, and carries on.
          </p>
          <Button disabled={busy} onClick={() => void resume()} data-testid="tc-continue">
            <Play /> Continue the job
          </Button>
        </>
      )}
      {step && <p className="text-xs text-muted-foreground">{step}</p>}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button variant="destructive" size="sm" onClick={() => void backend.jobStop().catch((e: unknown) => setError(errorMessage(e)))} data-testid="tc-stop">
        <Square /> Stop the job
      </Button>
    </div>
  );
}
