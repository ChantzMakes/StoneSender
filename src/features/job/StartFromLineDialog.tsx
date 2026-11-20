/**
 * Start from line N: pick the line, see how the app will get there (the
 * recovery lines), then continue to the normal pre-flight check.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/primitives';
import { stateBeforeLineInWorker } from '@/lib/gcode/client';
import { splitLines, tokenize } from '@/lib/gcode/interpreter';
import { buildRecovery, lastPlungeFeed, type Recovery } from '@/lib/job/recovery';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, unitLabel } from '@/lib/profile/units';
import { errorMessage } from '@/lib/utils';
import { useAnalysis } from '@/store/analysis';
import { useLink } from '@/store/link';
import { useSim } from '@/store/sim';

export interface StartFrom {
  line: number;
  recovery: Recovery;
}

/** First line at or after n that sends something. */
function sendableLine(lines: string[], n: number): number | null {
  for (let i = Math.max(1, n); i <= lines.length; i++) {
    const t = tokenize(lines[i - 1]!);
    if (t.words.length > 0) return i;
  }
  return null;
}

export function StartFromLineDialog({ open, onOpenChange, profile, onContinue }: { open: boolean; onOpenChange: (o: boolean) => void; profile: MachineProfile; onContinue: (s: StartFrom) => void }) {
  const text = useLink((s) => s.jobText);
  const lastJob = useLink((s) => s.job);
  const controller = useLink((s) => s.controller);
  const analysis = useAnalysis((s) => s.result);
  const [value, setValue] = useState('');
  const [result, setResult] = useState<StartFrom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const units = profile.units;
  const u = unitLabel('length', units);

  useEffect(() => {
    if (!open) return;
    // Suggest where the last run stopped, else the line shown in the viewer / editor.
    const stopped = lastJob && lastJob.mode === 'run' && (lastJob.phase === 'stopped' || lastJob.phase === 'failed') && lastJob.currentLine > 0 ? lastJob.currentLine : null;
    setValue(String(stopped ?? (useSim.getState().line || 1)));
    setResult(null);
    setError(null);
  }, [open]);

  const compute = async () => {
    if (!text || !analysis) return;
    const lines = splitLines(text);
    const n = Math.floor(Number(value));
    if (!(n >= 1 && n <= lines.length)) {
      setError(`Enter a line between 1 and ${lines.length}.`);
      return;
    }
    const line = sendableLine(lines, n);
    if (line === null) {
      setError('Nothing is sent from that line to the end of the file.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const state = await stateBeforeLineInWorker(line);
      const recovery = buildRecovery({
        line,
        state,
        lines,
        profile,
        laserMode: controller?.settings['32'] !== undefined ? controller.settings['32'] === '1' : profile.machineType === 'laser',
        plungeFeed: lastPlungeFeed(analysis.toolpath, line),
      });
      setResult({ line, recovery });
      setValue(String(line));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const r = result?.recovery;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Start from a line</DialogTitle>
          <DialogDescription>
            Skip the start of the job — for example to finish a job that was stopped. The app restores the units, offsets, spindle and feed the job had at that line, retracts to the safe height, moves over the start point and feeds down to it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="start-line">Line number</Label>
            <Input
              id="start-line"
              className="tabular"
              inputMode="numeric"
              value={value}
              data-testid="start-line-input"
              onChange={(e) => {
                setValue(e.target.value);
                setResult(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && void compute()}
            />
          </div>
          <Button variant="secondary" onClick={() => void compute()} disabled={busy || !analysis} data-testid="start-line-preview">
            Show how
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {r && result && (
          <div className="flex flex-col gap-2 text-sm" data-testid="start-line-plan">
            <div>
              Starts at line {result.line}, at X{formatLength(r.start[0], units, 2)} Y{formatLength(r.start[1], units, 2)} Z{formatLength(r.start[2], units, 2)} {u}
              {r.tool > 0 ? ` with T${r.tool}` : ''}.
            </div>
            {r.blockers.map((b, i) => (
              <p key={i} className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">
                {b}
              </p>
            ))}
            {r.warnings.map((w, i) => (
              <p key={i} className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                {w}
              </p>
            ))}
            <div>
              <div className="text-xs font-medium text-muted-foreground">Sent first, one line at a time:</div>
              <pre className="max-h-40 overflow-y-auto rounded-md bg-muted p-2 text-xs">{r.prelude.join('\n')}</pre>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="start-line-continue"
            disabled={!result || (r?.blockers.length ?? 0) > 0}
            onClick={() => {
              if (result) onContinue(result);
            }}
          >
            Continue to pre-flight
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
