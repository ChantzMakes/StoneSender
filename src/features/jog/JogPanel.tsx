/**
 * Jog panel: click = one step, press and hold = continuous jog (cancelled on
 * release). Keyboard (only while the session's "Keyboard jog" switch is on —
 * owner decision): arrows = X/Y, Page Up/Down = Z by default (rebindable in
 * Preferences), same tap/hold rules, [ / ] change the step.
 * Continuous jogging streams short $J= chunks from the Rust engine while we
 * send heartbeats; if the UI stops sending them (frozen, focus lost) motion
 * stops by itself within ~0.35 s.
 */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, PanelTitle, Switch, Tip } from '@/components/ui/primitives';
import { HelpButton } from '@/features/help/HelpButton';
import { isTypingTarget } from '@/features/layout/useShortcuts';
import { bindings, displayKey, JOG_SHORTCUTS, keyName } from '@/lib/shortcuts';
import { useApp } from '@/store/app';
import { useUi } from '@/store/ui';
import { backend } from '@/lib/backend';
import { stepJog } from '@/lib/grbl/commands';
import { parseJogStep, stepTooLarge } from '@/lib/machine/jogStep';
import { useGamepad } from './useGamepad';
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
  // Jogging is allowed while a job waits for a tool change (to position over the touch plate).
  const jobActive = useLink((s) => isActivePhase(s.job?.phase) && s.job?.phase !== 'tool-change');
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
      const tooLarge = stepTooLarge(stepMm, dir, profile.geometry.envelope);
      if (tooLarge) {
        sysMessage(tooLarge, 'warn');
        return;
      }
      const line = stepJog({ x: dir[0] * stepMm, y: dir[1] * stepMm, z: dir[2] * stepMm }, feed);
      useLink
        .getState()
        .sendLine(line)
        .catch((e) => sysMessage(errorMessage(e), 'error'));
    } else {
      stopContinuous();
    }
  }, [feedXY, feedZ, profile.geometry.envelope, stepMm, stopContinuous]);

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


export function JogPanel({ profile }: { profile: MachineProfile }) {
  const units = profile.units;
  const available = useJogAvailable();
  const [stepMm, setStepMm] = useState(profile.defaults.jog.defaultStepMm);
  const [feedXY, setFeedXY] = useState(profile.defaults.jog.feedXY);
  const [feedZ, setFeedZ] = useState(profile.defaults.jog.feedZ);
  const { begin, end } = useJogger(profile, feedXY, feedZ, stepMm);
  const pad = useGamepad({ profile, available, feedXY, feedZ, stepMm, accel: (d) => accelFor(profile, useLink.getState().controller?.settings, d) });

  // Custom step (typed). It is the active step whenever the step isn't one of the presets.
  const [customText, setCustomText] = useState('');
  const custom = customText ? parseJogStep(customText, units) : null;
  const selectCustom = () => {
    if (custom?.mm !== undefined) setStepMm(custom.mm);
  };

  useEffect(() => {
    setStepMm(profile.defaults.jog.defaultStepMm);
    setFeedXY(profile.defaults.jog.feedXY);
    setFeedZ(profile.defaults.jog.feedZ);
    setCustomText('');
  }, [profile.id, profile.defaults.jog]);

  const keyboardJog = useUi((s) => s.keyboardJog);
  const setKeyboardJog = useUi((s) => s.setKeyboardJog);
  const overrides = useApp((s) => s.settings.shortcuts);
  const keys = bindings(overrides);
  const steps = profile.defaults.jog.stepsMm;

  useEffect(() => {
    if (!keyboardJog) return;
    const map = bindings(overrides);
    const byKey = new Map<string, string>();
    for (const [id, k] of map) if (k && (JOG_SHORTCUTS[id] || id === 'jog.stepUp' || id === 'jog.stepDown')) byKey.set(k, id);
    let held: string | null = null; // e.key of the key that started the jog
    const down = (e: KeyboardEvent) => {
      const name = keyName(e);
      const id = name ? byKey.get(name) : undefined;
      if (!id || isTypingTarget(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      if (id === 'jog.stepUp' || id === 'jog.stepDown') {
        setStepMm((cur) => {
          const i = steps.indexOf(cur);
          const j = Math.min(steps.length - 1, Math.max(0, (i < 0 ? 0 : i) + (id === 'jog.stepUp' ? 1 : -1)));
          return steps[j] ?? cur;
        });
        return;
      }
      if (!available || held) return;
      held = e.key;
      begin(JOG_SHORTCUTS[id]!);
    };
    const up = (e: KeyboardEvent) => {
      // Any release of the jog key ends it, whatever modifiers changed meanwhile.
      if (held && e.key.toLowerCase() === held.toLowerCase()) {
        held = null;
        end();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      if (held) end();
    };
  }, [available, begin, end, keyboardJog, overrides, steps]);

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
      <PanelTitle
        actions={
          <div className="flex items-center gap-2">
            <Tip
              content={
                <span>
                  Jog with the keyboard: {displayKey(keys.get('jog.x-') ?? null)} {displayKey(keys.get('jog.x+') ?? null)} {displayKey(keys.get('jog.y+') ?? null)} {displayKey(keys.get('jog.y-') ?? null)} move X/Y,{' '}
                  {displayKey(keys.get('jog.z+') ?? null)} / {displayKey(keys.get('jog.z-') ?? null)} move Z. Tap = one step, hold = move until you let go.
                  <br />
                  Off every time the app starts, so a stray key press can't move the machine.
                </span>
              }
            >
              <label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal normal-case tracking-normal text-muted-foreground">
                <Switch
                  checked={keyboardJog}
                  onCheckedChange={(on) => {
                    if (!on) end();
                    setKeyboardJog(on);
                  }}
                  aria-label="Keyboard jog"
                  data-testid="keyboard-jog"
                />
                Keys
              </label>
            </Tip>
            <HelpButton section="moving-the-machine-and-setting-zero" label="Help: jogging" />
          </div>
        }
      >
        Jog
      </PanelTitle>
      <div className="flex flex-col gap-3 p-3">
        {pad.connected && (
          <div className={cn('rounded-md border px-2 py-1 text-xs', pad.enabled ? 'border-warning/60 bg-warning/10' : 'text-muted-foreground')} data-testid="gamepad-status">
            🎮 {pad.jogging ? 'Gamepad jogging' : pad.enabled ? 'Gamepad enabled — sticks jog, D-pad steps' : 'Gamepad connected — hold LB to jog'}
          </div>
        )}
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
            <Tip content="Click a button to move one step. Hold it to move continuously until you let go.">
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
          <div className="mt-1.5 flex items-center gap-2">
            <label htmlFor="jog-custom-step" className="text-xs text-muted-foreground">
              Custom
            </label>
            <Tip content="Type any distance; each click of an arrow then moves exactly that far. A step larger than the axis's travel is not sent.">
              <Input
                id="jog-custom-step"
                data-testid="jog-custom-step"
                role="radio"
                aria-checked={!steps.includes(stepMm)}
                aria-invalid={!!custom?.error}
                className={cn('tabular h-8 flex-1 text-right', !steps.includes(stepMm) && 'border-primary ring-1 ring-primary', custom?.error && 'border-destructive')}
                inputMode="decimal"
                placeholder="e.g. 2.5"
                value={customText}
                onFocus={selectCustom}
                onChange={(e) => {
                  const text = e.target.value;
                  setCustomText(text);
                  const p = text ? parseJogStep(text, units) : null;
                  if (p?.mm !== undefined) setStepMm(p.mm);
                }}
                onKeyDown={(e) => {
                  // Enter selects the step; it never jogs from the text box.
                  if (e.key === 'Enter') {
                    selectCustom();
                    e.currentTarget.blur();
                  }
                }}
              />
            </Tip>
            <span className="text-xs text-muted-foreground">{unitLabel('length', units)}</span>
          </div>
          {custom?.error && (
            <div className="mt-1 text-xs text-destructive" data-testid="jog-custom-error">
              {custom.error}
            </div>
          )}
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
