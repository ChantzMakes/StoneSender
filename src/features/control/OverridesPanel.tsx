/** Live feed / rapid / spindle-or-laser overrides (real-time bytes 0x90–0x9D). */
import { HelpButton } from '@/features/help/HelpButton';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PanelTitle } from '@/components/ui/primitives';
import { OVR, overrideBytes, rapidByte } from '@/lib/grbl/overrides';
import type { MachineProfile } from '@/lib/profile/schema';
import { cn } from '@/lib/utils';
import { useLink } from '@/store/link';

function Slider({ label, value, testId, onCommit, disabled }: { label: string; value: number; testId: string; onCommit: (v: number) => void; disabled: boolean }) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('tabular font-mono font-semibold', value !== 100 && 'text-warning')} data-testid={`${testId}-value`}>
          {dragging ? local : value}%
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={OVR.feed.min}
          max={OVR.feed.max}
          step={1}
          value={local}
          disabled={disabled}
          aria-label={label}
          data-testid={testId}
          className="flex-1 accent-[var(--color-primary)]"
          onPointerDown={() => setDragging(true)}
          onChange={(e) => setLocal(Number(e.target.value))}
          onPointerUp={() => {
            setDragging(false);
            onCommit(local);
          }}
          onKeyUp={() => onCommit(local)}
        />
        <Button variant="ghost" size="icon-sm" disabled={disabled || value === 100} onClick={() => onCommit(100)} aria-label={`Reset ${label}`}>
          <RotateCcw />
        </Button>
      </div>
    </div>
  );
}

export function OverridesPanel({ profile }: { profile: MachineProfile }) {
  const connected = useLink((s) => s.state === 'connected');
  const legacy = useLink((s) => s.firmware?.legacy ?? false);
  const ov = useLink((s) => s.status?.overrides) ?? { feed: 100, rapid: 100, spindle: 100 };
  const sendRealtime = useLink((s) => s.sendRealtime);
  const disabled = !connected || legacy;
  const send = async (bytes: number[]) => {
    for (const b of bytes) await sendRealtime(b);
  };

  return (
    <div className="flex flex-col">
      <PanelTitle actions={<HelpButton section="overrides" label="Help: overrides" />}>Overrides</PanelTitle>
      <div className="flex flex-col gap-3 p-3">
        {legacy && <p className="text-xs text-warning">GRBL 0.9 has no live overrides.</p>}
        <Slider label="Feed" value={ov.feed} testId="ovr-feed" disabled={disabled} onCommit={(v) => void send(overrideBytes('feed', ov.feed, v))} />
        <Slider
          label={profile.machineType === 'laser' ? 'Laser power' : 'Spindle'}
          value={ov.spindle}
          testId="ovr-spindle"
          disabled={disabled}
          onCommit={(v) => void send(overrideBytes('spindle', ov.spindle, v))}
        />
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Rapids</span>
          <div className="flex gap-1">
            {([25, 50, 100] as const).map((r) => (
              <Button key={r} size="sm" variant={ov.rapid === r ? 'default' : 'outline'} disabled={disabled} onClick={() => void sendRealtime(rapidByte(r))}>
                {r}%
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
