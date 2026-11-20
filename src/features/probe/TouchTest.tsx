/**
 * Probe connection test (owner decision): before any probing move the user
 * touches the plate to the bit (or presses the tool setter) and the app must
 * see the probe pin trigger, then release. Catches an unplugged clip that
 * would otherwise drive the bit into the plate.
 */
import { CheckCircle2, CircleDashed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { backend } from '@/lib/backend';
import { useLink } from '@/store/link';

export function useTouchTest(active: boolean) {
  const pin = useLink((s) => !!s.status?.pins?.probe);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!active) setSeen(false);
  }, [active]);
  useEffect(() => {
    if (active && pin) setSeen(true);
  }, [active, pin]);
  return { pin, seen, passed: seen && !pin, reset: () => setSeen(false) };
}

export function TouchTest({ test, what = 'the touch plate to the bit' }: { test: ReturnType<typeof useTouchTest>; what?: string }) {
  const preview = backend.kind === 'browser' && backend.simulateProbeTouch;
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2 text-sm" data-testid="touch-test">
      <div className="flex items-center gap-2">
        {test.passed ? <CheckCircle2 className="size-4 text-success" /> : <CircleDashed className="size-4 text-muted-foreground" />}
        <span>
          {test.passed
            ? 'Probe connection works.'
            : test.pin
              ? 'Touch detected — now let go.'
              : `Connection test: briefly touch ${what}. The app won't probe until it sees the touch.`}
        </span>
      </div>
      {preview && !test.passed && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          data-testid="simulate-touch"
          onClick={() => {
            backend.simulateProbeTouch?.(true);
            setTimeout(() => backend.simulateProbeTouch?.(false), 300);
          }}
        >
          Simulate the touch (browser preview)
        </Button>
      )}
    </div>
  );
}
