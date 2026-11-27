/**
 * Pop-out status window (owner decision: display only). Shows machine state and job progress
 * with time left as a big progress bar, fed one-way by the main window (`lib/statusFeed`).
 * It has no controls that reach the machine; the only control pins the window on top.
 * If updates stop for 2.5 s the window says so and greys out instead of showing old values
 * as if they were live.
 */
import { Pin, PinOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogoMark } from '@/components/Logo';
import { OFFLINE_DOT, STATE_PILL, stateText } from '@/features/dro/stateStyle';
import { formatDuration } from '@/features/job/format';
import { formatLength } from '@/lib/profile/units';
import { formatRemaining, inTauri, subscribeStatus, type StatusSnapshot } from '@/lib/statusFeed';
import { applyTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const STALE_MS = 2500;

const PHASE: Record<string, { label: string; tone: string; bar: string }> = {
  starting: { label: 'Starting', tone: 'text-run', bar: 'bg-brand' },
  running: { label: 'Running', tone: 'text-run', bar: 'bg-brand' },
  finishing: { label: 'Finishing moves', tone: 'text-run', bar: 'bg-brand' },
  paused: { label: 'Paused', tone: 'text-hold', bar: 'bg-hold' },
  'paused-on-error': { label: 'Paused — error', tone: 'text-alarm', bar: 'bg-alarm' },
  stopping: { label: 'Stopping', tone: 'text-hold', bar: 'bg-hold' },
  'tool-change': { label: 'Tool change', tone: 'text-hold', bar: 'bg-hold' },
  completed: { label: 'Completed', tone: 'text-run', bar: 'bg-run' },
  stopped: { label: 'Stopped', tone: 'text-muted-foreground', bar: 'bg-muted-foreground' },
  failed: { label: 'Failed', tone: 'text-alarm', bar: 'bg-alarm' },
};

function usePinned(): [boolean, () => void] {
  const [pinned, setPinned] = useState(false);
  const toggle = () => {
    const next = !pinned;
    setPinned(next);
    if (inTauri)
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setAlwaysOnTop(next)).catch(() => setPinned(!next));
  };
  return [pinned, toggle];
}

export function StatusWindow() {
  const [snap, setSnap] = useState<StatusSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pinned, togglePin] = usePinned();

  useEffect(() => {
    document.title = 'StoneSender — Status';
    const off = subscribeStatus((s) => setSnap(s));
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => {
      off();
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (snap) applyTheme(snap.theme, snap.uiScale);
  }, [snap?.theme, snap?.uiScale]); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = !snap || now - snap.sentAt > STALE_MS;
  const job = snap?.job ?? null;
  const phase = job ? (PHASE[job.phase] ?? { label: job.phase, tone: 'text-muted-foreground', bar: 'bg-brand' }) : null;
  const pct = job ? Math.floor(job.fraction * 100) : 0;
  const state = snap?.connected && snap.state ? stateText(snap.state) : null;

  return (
    <div className="flex h-full flex-col gap-3 bg-background p-4 select-none" data-testid="status-window">
      <div className="flex items-center gap-2.5">
        <LogoMark className="size-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{snap?.profileName ?? 'StoneSender'}</span>
        {state ? (
          <span className={cn(STATE_PILL, state.tone, 'h-7 px-3 text-sm before:bg-current')} data-testid="status-state">
            {state.label}
          </span>
        ) : (
          <span className={cn(STATE_PILL, OFFLINE_DOT, 'h-7 px-3 text-sm')} data-testid="status-state">
            {snap ? 'Offline' : 'Waiting'}
          </span>
        )}
        {inTauri && (
          <button
            type="button"
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={pinned ? 'Stop keeping this window on top' : 'Keep this window on top'}
            aria-pressed={pinned}
            title={pinned ? 'On top of other windows' : 'Keep on top of other windows'}
            onClick={togglePin}
          >
            {pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
          </button>
        )}
      </div>

      {stale && (
        <div className="rounded-md border border-hold/50 bg-hold/10 px-3 py-1.5 text-sm text-hold" role="status" data-testid="status-stale">
          {snap ? 'No updates from the main StoneSender window — the values below may be out of date.' : 'Waiting for the main StoneSender window…'}
        </div>
      )}

      <div className={cn('flex min-h-0 flex-1 flex-col justify-center gap-3', stale && 'opacity-50')}>
        {job && phase ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-display text-lg font-semibold" title={job.name} data-testid="status-job-name">
                {job.name}
              </span>
              <span className={cn('shrink-0 text-sm font-semibold', phase.tone)} data-testid="status-phase">
                {job.mode === 'check' ? 'Check: ' : ''}
                {phase.label}
              </span>
            </div>
            <div
              className="relative h-16 overflow-hidden rounded-lg border bg-surface-sunken"
              role="progressbar"
              aria-label="Job progress"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              data-testid="status-progress"
            >
              <div className={cn('h-full transition-[width] duration-500', phase.bar)} style={{ width: `${job.fraction * 100}%` }} />
              <span className="tabular absolute inset-0 flex items-center justify-center font-display text-3xl font-bold text-foreground [text-shadow:0_0_6px_var(--surface)]">{pct}%</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Time left" value={formatRemaining(job.remainingMs)} big testId="status-remaining" />
              <Stat label="Elapsed" value={formatDuration(job.elapsedMs)} />
              <Stat label="Line" value={`${job.currentLine.toLocaleString()} / ${job.total.toLocaleString()}`} />
            </div>
          </>
        ) : (
          <div className="text-center text-sm text-muted-foreground" data-testid="status-no-job">
            {snap?.connected ? 'No job running.' : snap ? 'Not connected to a machine.' : ''}
          </div>
        )}
      </div>

      {snap?.connected && snap.wpos && (
        <div className={cn('tabular flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 font-mono text-sm', stale && 'opacity-50')}>
          {snap.axes.map((a, i) => (
            <span key={a}>
              <span className={cn('mr-1 font-display font-bold', { X: 'text-axis-x', Y: 'text-axis-y', Z: 'text-axis-z', A: 'text-axis-a' }[a])}>{a}</span>
              {a === 'A' ? (snap.wpos![i] ?? 0).toFixed(2) : formatLength(snap.wpos![i] ?? 0, snap.units)}
            </span>
          ))}
          <span className="ml-auto text-muted-foreground">
            F {Math.round(snap.units === 'inch' ? snap.feed / 25.4 : snap.feed)} · {snap.laser ? 'S' : 'RPM'} {Math.round(snap.spindle)}
          </span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, big, testId }: { label: string; value: string; big?: boolean; testId?: string }) {
  return (
    <div className="flex flex-col rounded-md bg-surface-sunken px-3 py-2">
      <span className="ss-label">{label}</span>
      <span className={cn('tabular font-mono font-medium', big ? 'text-2xl' : 'text-lg')} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
