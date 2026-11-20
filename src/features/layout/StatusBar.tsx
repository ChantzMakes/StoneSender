import { useEffect, useState } from 'react';
import { Tip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useLink } from '@/store/link';
import { useActiveProfile } from '@/store/profiles';

/** Green < 1 s since last data, amber < 3 s, red otherwise. */
function useHealth() {
  const lastRxAt = useLink((s) => s.lastRxAt);
  const state = useLink((s) => s.state);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (state !== 'connected') return { tone: 'off' as const, text: state };
  if (!lastRxAt) return { tone: 'warn' as const, text: 'waiting for controller…' };
  const age = now - lastRxAt;
  if (age < 1000) return { tone: 'ok' as const, text: 'healthy' };
  if (age < 3000) return { tone: 'warn' as const, text: `no data for ${(age / 1000).toFixed(1)} s` };
  return { tone: 'bad' as const, text: `no data for ${Math.round(age / 1000)} s — controller not responding` };
}

export function StatusBar() {
  const health = useHealth();
  const firmware = useLink((s) => s.firmware);
  const description = useLink((s) => s.description);
  const profile = useActiveProfile();
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t bg-muted/40 px-3 text-xs text-muted-foreground">
      <Tip content="Connection health: time since the controller last sent anything" side="top">
        <span className="flex items-center gap-1.5" data-testid="connection-health">
          <span className={cn('size-2 rounded-full', health.tone === 'ok' ? 'bg-success' : health.tone === 'warn' ? 'bg-warning' : health.tone === 'bad' ? 'bg-destructive' : 'bg-muted-foreground/40')} />
          {health.text}
        </span>
      </Tip>
      {description && <span>{description}</span>}
      {firmware && (
        <span>
          {firmware.kind === 'grblhal' ? 'grblHAL' : 'GRBL'} {firmware.version}
        </span>
      )}
      <span className="ml-auto">{profile ? `${profile.identity.name} · ${profile.units}` : 'no profile'}</span>
      <span className="font-medium text-warning">Software STOP is not an E-stop</span>
    </footer>
  );
}
