/**
 * Gamepad jogging (Gamepad API). Polls the first connected pad every frame
 * while the jog panel is shown; stick jogging uses the same continuous-jog
 * engine as the buttons (heartbeats, jog-cancel on release). Releasing the
 * enable button, centring the stick, losing the pad or hiding the window
 * stops the jog — the engine's 350 ms heartbeat watchdog backs this up.
 */
import { useEffect, useRef, useState } from 'react';
import { backend } from '@/lib/backend';
import { stepJog } from '@/lib/grbl/commands';
import { type Dir, needsRestart, type PadSnapshot, stepPresses, stickIntent } from '@/lib/machine/gamepad';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { useLink } from '@/store/link';

const HEARTBEAT_MS = 100;
const MIN_RESTART_MS = 150;

export interface GamepadStatus {
  connected: boolean;
  name: string | null;
  enabled: boolean;
  jogging: boolean;
}

function snapshot(p: Gamepad): PadSnapshot {
  return { axes: [...p.axes], buttons: p.buttons.map((b) => b.pressed) };
}

export function useGamepad(opts: { profile: MachineProfile; available: boolean; feedXY: number; feedZ: number; stepMm: number; accel: (dir: Dir) => number }): GamepadStatus {
  const settings = useApp((s) => s.settings.gamepad);
  const [status, setStatus] = useState<GamepadStatus>({ connected: false, name: null, enabled: false, jogging: false });
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    if (!settings.enabled || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let raf = 0;
    let prev: PadSnapshot | null = null;
    let jog: { dir: Dir; magnitude: number; at: number } | null = null;
    let lastBeat = 0;
    let shown: GamepadStatus = { connected: false, name: null, enabled: false, jogging: false };

    const stop = () => {
      if (jog) {
        jog = null;
        backend.jogStop().catch(() => undefined);
      }
    };
    const publish = (s: GamepadStatus) => {
      if (s.connected !== shown.connected || s.enabled !== shown.enabled || s.jogging !== shown.jogging || s.name !== shown.name) {
        shown = s;
        setStatus(s);
      }
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pad = [...navigator.getGamepads()].find((p): p is Gamepad => !!p && p.connected);
      if (!pad) {
        stop();
        prev = null;
        publish({ connected: false, name: null, enabled: false, jogging: false });
        return;
      }
      const o = ref.current;
      const cur = snapshot(pad);
      const intent = stickIntent(cur, settings);
      const now = performance.now();
      if (!o.available || !intent.enabled || intent.magnitude === 0) {
        stop();
      } else {
        const zOnly = intent.dir[2] !== 0;
        const feed = Math.max(0.1, intent.magnitude) * (zOnly ? o.feedZ : o.feedXY);
        if (needsRestart(jog, intent) && (!jog || now - jog.at > MIN_RESTART_MS)) {
          jog = { dir: intent.dir, magnitude: intent.magnitude, at: now };
          backend.jogStart(intent.dir, feed, o.accel(intent.dir)).catch((e: unknown) => {
            jog = null;
            sysMessage(errorMessage(e), 'error');
          });
        } else if (jog && now - lastBeat > HEARTBEAT_MS) {
          lastBeat = now;
          backend.jogHeartbeat().catch(() => undefined);
        }
      }
      // D-pad / face buttons: single steps while enabled and not stick-jogging
      if (o.available && !jog) {
        for (const d of stepPresses(prev, cur, settings.enableButton)) {
          const line = stepJog({ x: d[0] * o.stepMm, y: d[1] * o.stepMm, z: d[2] * o.stepMm }, d[2] !== 0 ? o.feedZ : o.feedXY);
          useLink
            .getState()
            .sendLine(line)
            .catch((e: unknown) => sysMessage(errorMessage(e), 'error'));
        }
      }
      prev = cur;
      publish({ connected: true, name: pad.id, enabled: intent.enabled, jogging: !!jog });
    };
    raf = requestAnimationFrame(loop);
    const onHide = () => stop();
    window.addEventListener('blur', onHide);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('gamepaddisconnected', onHide);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('blur', onHide);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('gamepaddisconnected', onHide);
      stop();
    };
  }, [settings.enabled, settings.enableButton, settings.deadzone]);

  return status;
}
