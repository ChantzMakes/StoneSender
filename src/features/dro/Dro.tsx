/** Digital read-out: work & machine coordinates, state, feed and spindle/laser. */
import { Gauge, Zap } from 'lucide-react';
import { Badge, PanelTitle } from '@/components/ui/primitives';
import type { MachineState } from '@/lib/backend';
import { axesFor, hasLaser } from '@/lib/profile/geometry';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, toDisplay, unitLabel } from '@/lib/profile/units';
import { cn } from '@/lib/utils';
import { useLink } from '@/store/link';

const STATE_STYLE: Record<string, { label: string; variant: 'success' | 'info' | 'warning' | 'destructive' | 'secondary' }> = {
  idle: { label: 'Idle', variant: 'success' },
  run: { label: 'Running', variant: 'info' },
  jog: { label: 'Jogging', variant: 'info' },
  home: { label: 'Homing', variant: 'info' },
  hold: { label: 'Hold', variant: 'warning' },
  door: { label: 'Door open', variant: 'warning' },
  check: { label: 'Check mode', variant: 'secondary' },
  sleep: { label: 'Sleep', variant: 'secondary' },
  tool: { label: 'Tool change', variant: 'warning' },
  alarm: { label: 'ALARM', variant: 'destructive' },
  unknown: { label: 'Unknown', variant: 'secondary' },
};

export function StateBadge({ state }: { state: MachineState | null | undefined }) {
  if (!state) return <Badge variant="secondary">—</Badge>;
  const s = STATE_STYLE[state.name] ?? STATE_STYLE.unknown!;
  const sub = state.name === 'hold' ? (state.sub === 1 ? ' (stopping)' : '') : state.name === 'door' && state.sub !== undefined ? ` ${state.sub}` : '';
  return (
    <Badge variant={s.variant} className="px-2.5 py-1 text-sm" data-testid="machine-state">
      {s.label}
      {sub}
    </Badge>
  );
}

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
          <div key={axis} className="grid grid-cols-[2rem_1fr] items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
            <span className={cn('text-xl font-bold', axis === 'X' ? 'text-red-400' : axis === 'Y' ? 'text-green-400' : axis === 'Z' ? 'text-blue-400' : 'text-amber-400')}>{axis}</span>
            <div className="flex flex-col items-end">
              <span className="tabular font-mono text-3xl leading-none font-semibold" data-testid={`dro-work-${axis}`}>
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
          <div className="rounded-lg border p-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Gauge className="size-3.5" /> Feed
            </div>
            <div className="tabular font-mono text-lg">
              {feed.toFixed(units === 'inch' ? 1 : 0)} <span className="text-xs text-muted-foreground">{unitLabel('feed', units)}</span>
            </div>
            {status && status.overrides.feed !== 100 && <div className="text-xs text-warning">override {status.overrides.feed}%</div>}
          </div>
          <div className="rounded-lg border p-2">
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
