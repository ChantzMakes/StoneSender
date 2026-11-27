/**
 * Main window side of the pop-out status window: publishes a snapshot when something
 * changed (at most 4×/s) and at least once a second, so the pop-out can tell a live feed
 * from a stalled one.
 */
import { useEffect } from 'react';
import { axesFor } from '@/lib/profile/geometry';
import { jobProgress, publishStatus, type StatusSnapshot } from '@/lib/statusFeed';
import { plannedRemaining, useAnalysis } from '@/store/analysis';
import { useApp } from '@/store/app';
import { isActivePhase, useLink } from '@/store/link';
import { useActiveProfile } from '@/store/profiles';

const TICK_MS = 250;
const KEEPALIVE_MS = 1000;

export function useStatusPublisher() {
  const profile = useActiveProfile();
  useEffect(() => {
    let last = '';
    let lastAt = 0;
    const tick = () => {
      const link = useLink.getState();
      const analysis = useAnalysis.getState().result;
      const status = link.status;
      const connected = link.state === 'connected';
      const job = link.job;
      const active = isActivePhase(job?.phase);
      const plan = analysis ? { totalS: analysis.stats.time.total, remainingS: job ? plannedRemaining(analysis, job.currentLine) : null } : null;
      const app = useApp.getState().settings;
      const snap: Omit<StatusSnapshot, 'sentAt'> = {
        v: 1,
        theme: app.theme,
        uiScale: app.uiScale,
        connected,
        profileName: profile?.identity.name ?? null,
        laser: profile?.machineType === 'laser',
        units: profile?.units ?? 'mm',
        state: connected && status?.state ? { name: status.state.name, sub: status.state.sub } : null,
        axes: profile ? axesFor(profile) : ['X', 'Y', 'Z'],
        wpos: connected && status ? status.wpos : null,
        feed: connected && status ? status.feed : 0,
        spindle: connected && status ? status.spindle : 0,
        overrides: connected && status ? status.overrides : null,
        job: job
          ? {
              name: job.name,
              mode: job.mode,
              phase: job.phase,
              acked: job.acked,
              total: job.total,
              currentLine: job.currentLine,
              elapsedMs: job.elapsedMs,
              ...jobProgress(job, active, plan),
            }
          : null,
      };
      const key = JSON.stringify(snap);
      const now = Date.now();
      if (key === last && now - lastAt < KEEPALIVE_MS) return;
      last = key;
      lastAt = now;
      void publishStatus({ ...snap, sentAt: now }).catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [profile]);
}
