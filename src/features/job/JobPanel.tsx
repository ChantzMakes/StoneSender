/** Job panel: open a file, pre-flight, run/check, pause/resume/stop, progress. */
import { FileUp, History, Pause, Play, ShieldCheck, Square, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, PanelTitle, Tip } from '@/components/ui/primitives';
import { backend, type JobMode } from '@/lib/backend';
import { errorInfo } from '@/lib/grbl/codes';
import type { MachineProfile } from '@/lib/profile/schema';
import { cn, errorMessage } from '@/lib/utils';
import { plannedRemaining, useAnalysis } from '@/store/analysis';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { formatDuration } from './format';
import { JobHistoryDialog } from './JobHistoryDialog';
import { JobStats } from './JobStats';
import { PreflightDialog } from './PreflightDialog';

export { formatDuration };

const PHASE_LABEL: Record<string, { label: string; variant: 'info' | 'warning' | 'success' | 'destructive' | 'secondary' }> = {
  starting: { label: 'Starting', variant: 'info' },
  running: { label: 'Running', variant: 'info' },
  paused: { label: 'Paused', variant: 'warning' },
  'paused-on-error': { label: 'Paused — error', variant: 'destructive' },
  finishing: { label: 'Finishing moves', variant: 'info' },
  stopping: { label: 'Stopping', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  stopped: { label: 'Stopped', variant: 'secondary' },
  failed: { label: 'Failed', variant: 'destructive' },
};

export function JobPanel({ profile }: { profile: MachineProfile }) {
  const loaded = useLink((s) => s.loadedJob);
  const job = useLink((s) => s.job);
  const connected = useLink((s) => s.state === 'connected');
  const openJob = useLink((s) => s.openJob);
  const loadJobPath = useLink((s) => s.loadJobPath);
  const recent = useApp((s) => s.settings.recentFiles);
  const analysis = useAnalysis((s) => s.result);
  const [historyOpen, setHistoryOpen] = useState(false);
  const unloadJob = useLink((s) => s.unloadJob);
  const [preflightMode, setPreflightMode] = useState<JobMode | null>(null);
  const active = isActivePhase(job?.phase);

  const act = (f: () => Promise<void>) => f().catch((e) => sysMessage(errorMessage(e), 'error'));

  const progress = job && job.total > 0 ? job.acked / job.total : 0;
  // Planner estimate for what is left (falls back to a line-count estimate).
  const planned = active && job?.mode === 'run' ? plannedRemaining(analysis, job.currentLine) : null;
  const remainingMs = planned !== null ? planned * 1000 : job && job.acked > 0 && active ? (job.elapsedMs * (job.total - job.acked)) / job.acked : null;
  const f = loaded?.scan.features;
  const lastError = job?.errors.at(-1);
  const lastErrorInfo = errorInfo(lastError?.code);

  return (
    <div className="flex flex-col">
      <PanelTitle
        actions={
          <>
            <Tip content="Job history">
              <Button variant="ghost" size="icon-sm" onClick={() => setHistoryOpen(true)} aria-label="Job history" data-testid="job-history-button">
                <History />
              </Button>
            </Tip>
            {loaded && !active && (
              <Tip content="Close this file">
                <Button variant="ghost" size="icon-sm" onClick={() => void act(unloadJob)} aria-label="Close file">
                  <X />
                </Button>
              </Tip>
            )}
          </>
        }
      >
        Job
      </PanelTitle>
      <div className="flex flex-col gap-3 p-3">
        {!loaded ? (
          <div className="flex flex-col gap-2">
            <Button variant="outline" data-testid="open-job" onClick={() => void act(openJob)}>
              <FileUp /> Open G-code file…
            </Button>
            <p className="text-center text-xs text-muted-foreground">or drop a file on the window</p>
            {recent.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="text-xs font-medium text-muted-foreground">Recent</div>
                {recent.slice(0, 5).map((p) => (
                  <button key={p} type="button" title={p} className="cursor-pointer truncate rounded px-1 py-0.5 text-left text-xs hover:bg-accent" onClick={() => void act(() => loadJobPath(p))}>
                    {p.split(/[\/]/).pop()}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="truncate font-medium" title={loaded.name} data-testid="job-name">
              {loaded.name}
            </div>
            <div className="text-xs text-muted-foreground">
              {loaded.scan.lines.toLocaleString()} lines · {(loaded.sizeBytes / 1024).toFixed(loaded.sizeBytes > 10240 ? 0 : 1)} KB
              {f?.tools.length ? ` · tools ${f.tools.map((t) => `T${t}`).join(', ')}` : ''}
            </div>
            <div className="flex flex-wrap gap-1">
              {f?.unitsMm && <Badge variant="secondary">mm</Badge>}
              {f?.unitsInch && <Badge variant="secondary">inch</Badge>}
              {f?.arcs && <Badge variant="secondary">arcs</Badge>}
              {(f?.spindleCw || f?.spindleCcw) && <Badge variant="secondary">{profile.machineType === 'laser' ? 'laser on' : 'spindle on'}</Badge>}
              {f?.probe && <Badge variant="warning">probing</Badge>}
              {f && f.toolChanges.length > 0 && <Badge variant="warning">{f.toolChanges.length} tool change(s)</Badge>}
              {loaded.scan.issues.some((i) => i.severity === 'error') && <Badge variant="destructive">problems found</Badge>}
            </div>
          </div>
        )}

        {loaded && !active && <JobStats profile={profile} />}

        {loaded && !active && (
          <div className="grid grid-cols-2 gap-2">
            <Button data-testid="run-job" disabled={!connected} onClick={() => setPreflightMode('run')}>
              <Play /> Run
            </Button>
            <Tip content="Dry run: the controller checks every line ($C) without moving">
              <span>
                <Button variant="outline" className="w-full" data-testid="check-job" disabled={!connected} onClick={() => setPreflightMode('check')}>
                  <ShieldCheck /> Check
                </Button>
              </span>
            </Tip>
          </div>
        )}

        {job && (
          <div className="flex flex-col gap-2" data-testid="job-progress">
            <div className="flex items-center justify-between">
              <Badge variant={PHASE_LABEL[job.phase]?.variant ?? 'secondary'}>
                {job.mode === 'check' ? 'Check: ' : ''}
                {PHASE_LABEL[job.phase]?.label ?? job.phase}
              </Badge>
              <span className="tabular text-xs text-muted-foreground">line {job.currentLine.toLocaleString()}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn('h-full transition-[width]', job.phase === 'failed' ? 'bg-destructive' : 'bg-primary')} style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="tabular flex justify-between text-xs text-muted-foreground">
              <span>
                {job.acked.toLocaleString()} / {job.total.toLocaleString()} ({Math.floor(progress * 100)}%)
              </span>
              <span>
                {formatDuration(job.elapsedMs)} elapsed{remainingMs !== null ? ` · ~${formatDuration(remainingMs)} left` : ''}
              </span>
            </div>
            {job.phase === 'paused-on-error' && lastError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs" role="alert">
                <div className="font-semibold">
                  Line {lastError.sourceLine}: error:{lastError.code ?? lastError.text}
                  {lastErrorInfo ? ` — ${lastErrorInfo.title}` : ''}
                </div>
                <code className="block truncate">{lastError.lineText}</code>
                {lastErrorInfo && <div className="mt-1">{lastErrorInfo.fix}</div>}
                <div className="mt-1 text-muted-foreground">The machine is holding. Continue skips this line; Stop ends the job.</div>
              </div>
            )}
            {job.mode === 'check' && !active && job.errorCount > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-md border p-2 text-xs" data-testid="check-errors">
                {job.errors.map((e, i) => (
                  <li key={i}>
                    Line {e.sourceLine}: error:{e.code ?? e.text} {errorInfo(e.code)?.title ?? ''} — <code>{e.lineText}</code>
                  </li>
                ))}
              </ul>
            )}
            {job.message && !active && <p className="text-xs text-muted-foreground">{job.message}</p>}
            {active && (
              <div className="grid grid-cols-2 gap-2">
                {job.phase === 'paused' || job.phase === 'paused-on-error' ? (
                  <Button data-testid="resume-job" onClick={() => void act(backend.jobResume)}>
                    <Play /> {job.phase === 'paused-on-error' ? 'Continue' : 'Resume'}
                  </Button>
                ) : (
                  <Button variant="secondary" data-testid="pause-job" disabled={job.phase === 'stopping' || job.phase === 'finishing'} onClick={() => void act(backend.jobPause)}>
                    <Pause /> Pause
                  </Button>
                )}
                <Button variant="destructive" data-testid="stop-job" disabled={job.phase === 'stopping'} onClick={() => void act(backend.jobStop)}>
                  <Square /> Stop
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <PreflightDialog mode={preflightMode} profile={profile} onClose={() => setPreflightMode(null)} />
      <JobHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  );
}
