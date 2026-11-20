/** Job statistics from the interpreter + planner (estimated time, size, depth, feeds, tools). */
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, toDisplay, unitLabel } from '@/lib/profile/units';
import { useAnalysis } from '@/store/analysis';
import { formatDuration } from './format';

export function JobStats({ profile }: { profile: MachineProfile }) {
  const { status, stage, fraction, result, error } = useAnalysis();
  const units = profile.units;
  const u = unitLabel('length', units);

  if (status === 'running') {
    return (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="analysis-progress">
        {stage}…
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary/60 transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      </div>
    );
  }
  if (status === 'error') return <p className="text-xs text-destructive">Could not analyse the job: {error}</p>;
  if (!result) return null;
  const s = result.stats;
  const len = (v: number, d = 1) => formatLength(v, units, d);
  const row = (label: string, value: React.ReactNode, testId?: string) => (
    <div className="flex justify-between gap-2" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular text-right font-medium">{value}</span>
    </div>
  );
  const cut = s.cutBounds.empty ? s.workBounds : s.cutBounds;
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;

  return (
    <div className="flex flex-col gap-1 rounded-md border p-2 text-xs" data-testid="job-stats">
      {row('Estimated time', formatDuration(s.time.total * 1000), 'stat-time')}
      {!cut.empty && row('Size (W × D × H)', `${len(cut.max[0] - cut.min[0])} × ${len(cut.max[1] - cut.min[1])} × ${len(cut.max[2] - cut.min[2])} ${u}`)}
      {!cut.empty && row('X range', `${len(cut.min[0])} … ${len(cut.max[0])}`)}
      {!cut.empty && row('Y range', `${len(cut.min[1])} … ${len(cut.max[1])}`)}
      {s.minCutZ !== null && profile.machineType !== 'laser' && row('Deepest cut', `Z ${len(s.minCutZ, 2)} ${u}`, 'stat-depth')}
      {s.feedRange &&
        row(
          'Feed',
          `${Math.round(toDisplay(s.feedRange[0], 'feed', units))}–${Math.round(toDisplay(s.feedRange[1], 'feed', units))} ${unitLabel('feed', units)}`,
        )}
      {s.spindleRange && row(profile.machineType === 'laser' ? 'Power (S)' : 'Spindle (S)', `${s.spindleRange[0]}–${s.spindleRange[1]}`)}
      {s.tools.length > 0 && row('Tools', s.tools.map((t) => `T${t.tool}`).join(', '))}
      {row('Cutting / rapid', `${len(s.distance.cut / (units === 'inch' ? 1 : 1000), units === 'inch' ? 0 : 2)} ${units === 'inch' ? 'in' : 'm'} / ${len(s.distance.rapid / (units === 'inch' ? 1 : 1000), units === 'inch' ? 0 : 2)} ${units === 'inch' ? 'in' : 'm'}`)}
      {result.pauses.length > 0 && row('Pauses (M0)', result.pauses.length)}
      {errors > 0 && <div className="text-destructive">{errors} line(s) the controller will reject — see the G-code tab.</div>}
      <div className="pt-1 text-[10px] text-muted-foreground">Time from a model of GRBL’s planner (accelerations and corner speeds). Overrides and pauses are not included.</div>
    </div>
  );
}
