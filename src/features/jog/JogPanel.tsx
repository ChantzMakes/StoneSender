/**
 * Jog panel: click = one step, press and hold = continuous jog (cancelled on
 * release). Keyboard: arrows = X/Y, Page Up/Down = Z, same tap/hold rules.
 * Continuous jogging streams short $J= chunks from the Rust engine while we
 * send heartbeats; if the UI stops sending them (frozen, focus lost) motion
 * stops by itself within ~0.35 s.
 */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, PanelTitle, Tip } from '@/components/ui/primitives';
import { backend } from '@/lib/backend';
import { stepJog } from '@/lib/grbl/commands';
import type { MachineProfile } from '@/lib/profile/schema';
import { fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { cn, errorMessage } from '@/lib/utils';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';

const HOLD_MS = 250;
const HEARTBEAT_MS = 100;

type Dir = [number, number, number];

export function useJogAvailable(): boolean {
  const connected = useLink((s) => s.state === 'connected');
  const state = useLink((s) => s.status?.state?.name);
  const jobActive = useLink((s) => isActivePhase(s.job?.phase));
  return connected && (state === 'idle' || state === 'jog') && !jobActive;
}

function accelFor(profile: MachineProfile, settings: Record<string, string> | undefined, dir: Dir): number {
  const vals = (['x', 'y', 'z'] as const).map((a, i) => {
    const c = settings ? Number(settings[String(120 + i)]) : NaN;
    return Number.isFinite(c) && c > 0 ? c : profile.motion.acceleration[a];
  });
  return Math.min(...vals.filter((_, i) => dir[i] !== 0));
}

/** Shared tap/hold logic for buttons and keys. */
function useJogger(profile: MachineProfile, feedXY: number, feedZ: number, stepMm: number) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beat = useRef<ReturnType<typeof setInterval> | null>(null);
  const continuous = useRef(false);
  const active = useRef<Dir | null>(null);

  const stopContinuous = useCallback(() => {
    if (beat.current) clearInterval(beat.current);
    beat.current = null;
    if (continuous.current) {
      continuous.current = false;
      backend.jogStop().catch(() => undefined);
    }
  }, []);

  const begin = useCallback(
    (dir: Dir) => {
      if (active.current) return;
      active.current = dir;
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        const feed = dir[2] !== 0 && dir[0] === 0 && dir[1] === 0 ? feedZ : feedXY;
        continuous.current = true;
        const settings = useLink.getState().controller?.settings;
        backend.jogStart(dir, feed, accelFor(profile, settings, dir)).catch((e) => {
          continuous.current = false;
          sysMessage(errorMessage(e), 'error');
        });
        beat.current = setInterval(() => backend.jogHeartbeat().catch(() => undefined), HEARTBEAT_MS);
      }, HOLD_MS);
    },
    [feedXY, feedZ, profile],
  );

  const end = useCallback(() => {
    const dir = active.current;
    active.current = null;
    if (!dir) return;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      const feed = dir[2] !== 0 ? feedZ : feedXY;
      const line = stepJog({ x: dir[0] * stepMm, y: dir[1] * stepMm, z: dir[2] * stepMm }, feed);
      useLink
        .getState()
        .sendLine(line)
        .catch((e) => sysMessage(errorMessage(e), 'error'));
    } else {
      stopContinuous();
    }
  }, [feedXY, feedZ, stepMm, stopContinuous]);

  // Stop if the window loses focus or the component goes away.
  useEffect(() => {
    const onBlur = () => end();
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onBlur);
      end();
    };
  }, [end]);

  return { begin, end };
}

const KEYS: Record<string, Dir> = {
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0],
  ArrowUp: [0, 1, 0],
  ArrowDown: [0, -1, 0],
  PageUp: [0, 0, 1],
  PageDown: [0, 0, -1],
};

function typingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('[role="dialog"],[role="listbox"],[role="menu"]'));
}

export function JogPanel({ profile }: { profile: MachineProfile }) {
  const units = profile.units;
  const available = useJogAvailable();
  const [stepMm, setStepMm] = useState(profile.defaults.jog.defaultStepMm);
  const [feedXY, setFeedXY] = useState(profile.defaults.jog.feedXY);
  const [feedZ, setFeedZ] = useState(profile.defaults.jog.feedZ);
  const { begin, end } = useJogger(profile, feedXY, feedZ, stepMm);

  useEffect(() => {
    setStepMm(profile.defaults.jog.defaultStepMm);
    setFeedXY(profile.defaults.jog.feedXY);
    setFeedZ(profile.defaults.jog.feedZ);
  }, [profile.id, profile.defaults.jog]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const dir = KEYS[e.key];
      if (!dir || typingTarget(e.target) || !available) return;
      e.preventDefault();
      if (!e.repeat) begin(dir);
    };
    const up = (e: KeyboardEvent) => {
      if (KEYS[e.key]) end();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [available, begin, end]);

  const btn = (dir: Dir, label: string, icon: React.ReactNode, testId: string, className?: string) => (
    <Button
      variant="secondary"
      className={cn('h-12 w-full touch-none text-base', className)}
      disabled={!available}
      aria-label={label}
      data-testid={testId}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        begin(dir);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) begin(dir);
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') end();
      }}
    >
      {icon}
    </Button>
  );

  const disp = (mm: number) => roundForDisplay(toDisplay(mm, 'length', units), 'length', units);

  return (
    <div className="flex flex-col">
      <PanelTitle>Jog</PanelTitle>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex gap-3">
          <div className="grid flex-1 grid-cols-3 gap-1.5">
            <div />
            {btn([0, 1, 0], 'Jog Y+ (back)', <ArrowUp />, 'jog-y-plus')}
            <div />
            {btn([-1, 0, 0], 'Jog X− (left)', <ArrowLeft />, 'jog-x-minus')}
            <div className="flex items-center justify-center text-xs text-muted-foreground">XY</div>
            {btn([1, 0, 0], 'Jog X+ (right)', <ArrowRight />, 'jog-x-plus')}
            <div />
            {btn([0, -1, 0], 'Jog Y− (front)', <ArrowDown />, 'jog-y-minus')}
            <div />
          </div>
          <div className="grid w-16 grid-rows-3 gap-1.5">
            {btn([0, 0, 1], 'Jog Z+ (up)', <ChevronsUp />, 'jog-z-plus')}
            <div className="flex items-center justify-center text-xs text-muted-foreground">Z</div>
            {btn([0, 0, -1], 'Jog Z− (down)', <ChevronsDown />, 'jog-z-minus')}
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>Step ({unitLabel('length', units)})</span>
            <Tip content="Click a button to move one step. Hold it (or an arrow key / Page Up / Page Down) to move continuously until you let go.">
              <span className="cursor-help underline decoration-dotted">click = step, hold = move</span>
            </Tip>
          </div>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Jog step">
            {profile.defaults.jog.stepsMm.map((s) => (
              <Button key={s} size="sm" role="radio" aria-checked={s === stepMm} variant={s === stepMm ? 'default' : 'outline'} className="tabular min-w-12 flex-1" onClick={() => setStepMm(s)}>
                {disp(s)}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['XY speed', feedXY, setFeedXY],
              ['Z speed', feedZ, setFeedZ],
            ] as const
          ).map(([label, value, setter]) => (
            <label key={label} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {label} ({unitLabel('feed', units)})
              <Input
                className="tabular h-8 text-right"
                inputMode="decimal"
                value={roundForDisplay(toDisplay(value, 'feed', units), 'feed', units)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) setter(fromDisplay(n, 'feed', units));
                }}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
