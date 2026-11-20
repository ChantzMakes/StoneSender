/**
 * Job analysis (interpret → plan → stats) for the loaded file, run in the
 * worker. Re-runs when the job text, the active profile or the controller's
 * motion settings change.
 *
 * Analysis uses zero work offsets, so "machine" coordinates in the result are
 * really coordinates relative to the work zero; pre-flight adds the live WCO
 * from the status report to check the job against the machine envelope.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { analyzeInWorker, type AnalysisResult, SupersededError } from '@/lib/gcode/client';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { useLink } from './link';
import { useActiveProfile } from './profiles';

interface AnalysisStore {
  status: 'idle' | 'running' | 'done' | 'error';
  stage: string;
  fraction: number;
  result: AnalysisResult | null;
  error: string | null;
  /** Key of the inputs the current result belongs to */
  key: string | null;
}

export const useAnalysis = create<AnalysisStore>(() => ({ status: 'idle', stage: '', fraction: 0, result: null, error: null, key: null }));

const MOTION_SETTINGS = [11, 12, 32, 110, 111, 112, 113, 120, 121, 122, 123];

function inputKey(text: string | null, profile: MachineProfile | null, settings: Record<string, string> | undefined, plannerBlocks: number | null | undefined): string | null {
  if (!text || !profile) return null;
  const s = MOTION_SETTINGS.map((id) => settings?.[String(id)] ?? '').join(',');
  return `${text.length}:${hash(text)}|${profile.id}:${profile.updatedAt}|${s}|${plannerBlocks ?? ''}`;
}

/** Cheap string hash so edited text with the same length re-analyses. */
function hash(text: string): number {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(text.length / 200000));
  for (let i = 0; i < text.length; i += step) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Mount once (App): keeps the analysis in sync with its inputs. */
export function useAnalysisSync() {
  const text = useLink((s) => s.jobText);
  const profile = useActiveProfile();
  const settings = useLink((s) => s.controller?.settings);
  const plannerBlocks = useLink((s) => s.controller?.build.plannerBlocks);
  const key = inputKey(text, profile, settings, plannerBlocks);

  useEffect(() => {
    if (timer) clearTimeout(timer);
    if (!key || !text || !profile) {
      useAnalysis.setState({ status: 'idle', result: null, error: null, key: null });
      return;
    }
    if (useAnalysis.getState().key === key) return;
    timer = setTimeout(() => {
      useAnalysis.setState({ status: 'running', stage: 'Reading G-code', fraction: 0, error: null });
      analyzeInWorker({ text, profile, controllerSettings: settings, plannerBlocks }, (stage, fraction) => useAnalysis.setState({ stage, fraction }))
        .then((result) => useAnalysis.setState({ status: 'done', result, key }))
        .catch((e) => {
          if (e instanceof SupersededError) return;
          useAnalysis.setState({ status: 'error', error: errorMessage(e), key });
        });
    }, 250);
    // `key` captures every input.
  }, [key]);
}

/** Planned seconds remaining after the given source line (null if unknown). */
export function plannedRemaining(result: AnalysisResult | null, line: number): number | null {
  if (!result || result.lineEndTime.length === 0) return null;
  const total = result.stats.time.total;
  const done = result.lineEndTime[Math.min(Math.max(line, 0), result.lineEndTime.length - 1)] ?? 0;
  return Math.max(0, total - done);
}
