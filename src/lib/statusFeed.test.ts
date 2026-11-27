import { describe, expect, it } from 'vitest';
import { formatRemaining, jobProgress } from './statusFeed';

const job = { acked: 250, total: 1000, elapsedMs: 60_000, currentLine: 250, mode: 'run' as const };

describe('pop-out job progress', () => {
  it('uses the planner when the analysis knows the job', () => {
    const p = jobProgress(job, true, { totalS: 600, remainingS: 150 });
    expect(p.fraction).toBeCloseTo(0.75);
    expect(p.remainingMs).toBe(150_000);
  });

  it('falls back to lines when there is no plan, and for check runs', () => {
    expect(jobProgress(job, true, null)).toEqual({ fraction: 0.25, remainingMs: 180_000 });
    const check = jobProgress({ ...job, mode: 'check' }, true, { totalS: 600, remainingS: 150 });
    expect(check.fraction).toBe(0.25);
  });

  it('shows no time left once the job is over, and keeps a stopped job short of 100 %', () => {
    const stopped = jobProgress(job, false, { totalS: 600, remainingS: 150 });
    expect(stopped).toEqual({ fraction: 0.25, remainingMs: null });
    expect(jobProgress({ ...job, acked: 0 }, true, null).remainingMs).toBeNull();
    expect(formatRemaining(null)).toBe('—');
    expect(formatRemaining(3_725_000)).toBe('1:02:05');
  });
});
