/** Digital read-out: work & machine coordinates, state, feed and spindle/laser. */
import { Gauge, Zap } from 'lucide-react';
import { Badge, PanelTitle } from '@/components/ui/primitives';
import type { MachineState } from '@/lib/backend';
import { axesFor, hasLaser } from '@/lib/profile/geometry';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, toDisplay, unitLabel } from '@/lib/profile/units';
import { cn } from '@/lib/utils';
import { OFFLINE_DOT, STATE_PILL, stateText } from './stateStyle';
import { useLink } from '@/store/link';

export function StateBadge({ state }: { state: MachineState | null | undefined }) {
  // Disconnected: hollow dot
  if (!state) return <span className={cn(STATE_PILL, OFFLINE_DOT)}>Offline</span>;
  const s = stateText(state);
  return (
    <span className={cn(STATE_PILL, s.tone, 'before:bg-current')} data-testid="machine-state">
      {s.label}
    </span>
  );
}

const AXIS_TONE: Record<string, string> = { X: 'text-axis-x', Y: 'text-axis-y', Z: 'text-axis-z', A: 'text-axis-a' };

export function Dro({ profile }: { profile: MachineProfile }) {
  const status = useLink((s) => s.status);
  const connected = useLink((s) => s.state === 'connected');
  const axes = axesFor(profile);
  const units = profile.units;
  const laser = profile.machineType === 'laser';

  const value = (arr: number[] | undefined, i: number, axis: string) => {
    const v = arr?.[i];
    if (v === undefined) return '—';
    if (axis === 'A') return v.toFixed(2);
    return formatLength(v, units);
  };

  const feed = status ? toDisplay(status.feed, 'feed', units) : 0;
  const spindle = status?.spindle ?? 0;
  const powerPct = laser ? Math.round((spindle / profile.laser.maxPower) * 100) : 0;

  return (
    <div className="flex flex-col">
      <PanelTitle actions={<StateBadge state={connected ? status?.state : null} />}>Position</PanelTitle>
      <div className="flex flex-col gap-1.5 p-3">
        {axes.map((axis, i) => (
          <div key={axis} className="grid grid-cols-[2rem_1fr] items-center gap-3 rounded-md bg-surface-sunken px-3 py-2">
            <span className={cn('font-display text-xl font-bold', AXIS_TONE[axis])}>{axis}</span>
            <div className="flex flex-col items-end">
              <span className="tabular font-mono text-[1.75rem] leading-8 font-medium" data-testid={`dro-work-${axis}`}>
                {value(status?.wpos, i, axis)}
              </span>
              <span className="tabular font-mono text-xs text-muted-foreground">
                machine {value(status?.mpos, i, axis)}
              </span>
            </div>
          </div>
        ))}
        <div className="mt-1 flex justify-between px-1 text-xs text-muted-foreground">
          <span>Work coordinates ({units === 'inch' ? 'in' : 'mm'}{axes.includes('A') ? ', A in °' : ''})</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-md bg-surface-sunken p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Gauge className="size-3.5" /> Feed
            </div>
            <div className="tabular font-mono text-lg">
              {feed.toFixed(units === 'inch' ? 1 : 0)} <span className="text-xs text-muted-foreground">{unitLabel('feed', units)}</span>
            </div>
            {status && status.overrides.feed !== 100 && <div className="text-xs text-warning">override {status.overrides.feed}%</div>}
          </div>
          <div className="rounded-md bg-surface-sunken p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Zap className="size-3.5" /> {laser ? 'Laser power' : 'Spindle'}
            </div>
            <div className="tabular font-mono text-lg">
              {laser ? (
                <>
                  {powerPct}
                  <span className="text-xs text-muted-foreground"> %</span>
                </>
              ) : (
                <>
                  {Math.round(spindle)} <span className="text-xs text-muted-foreground">RPM</span>
                </>
              )}
            </div>
            {status && status.overrides.spindle !== 100 && <div className="text-xs text-warning">override {status.overrides.spindle}%</div>}
          </div>
        </div>
        {status && (status.accessories.flood || status.accessories.mist || status.pins.raw) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {status.accessories.flood && <Badge variant="info">{hasLaser(profile) && profile.laser.airAssist === 'M8' ? 'Air assist' : 'Flood'}</Badge>}
            {status.accessories.mist && <Badge variant="info">{hasLaser(profile) && profile.laser.airAssist === 'M7' ? 'Air assist' : 'Mist'}</Badge>}
            {status.pins.probe && <Badge variant="warning">Probe touching</Badge>}
            {(status.pins.x || status.pins.y || status.pins.z) && <Badge variant="destructive">Limit: {['x', 'y', 'z'].filter((a) => status.pins[a as 'x']).join(' ').toUpperCase()}</Badge>}
            {status.pins.door && <Badge variant="warning">Door</Badge>}
          </div>
        )}
      </div>
    </div>
  );
}
