/**
 * Always-visible software STOP: feed hold, then soft reset.
 *
 * GRBL keeps its position if a reset happens after the hold has finished
 * decelerating (Hold:0); a reset mid-motion raises ALARM:3 and loses
 * position. So we send `!` immediately and the reset as soon as the machine
 * reports it has stopped — or after STOP_RESET_TIMEOUT_MS at the latest, so a
 * missing status report can never delay the reset (which also turns off the
 * spindle/laser) by more than that.
 *
 * Shortcut: Escape (fixed — owner decision) plus an optional second key from
 * Preferences, but only while the machine may be moving, so Escape still
 * closes dialogs when idle. This is not an E-stop and the UI says so.
 */
import { OctagonX } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/primitives';
import { sysMessage } from '@/store/console';
import { backend } from '@/lib/backend';
import { bindings, displayKey, keyName } from '@/lib/shortcuts';
import { useApp } from '@/store/app';
import { isActivePhase, isMotionState, useLink } from '@/store/link';

export const STOP_RESET_TIMEOUT_MS = 800;

export async function emergencyStop() {
  const link = useLink.getState();
  if (link.state === 'disconnected') return;
  sysMessage('STOP pressed: feed hold, then reset.', 'warn');
  const phase = link.job?.phase;
  if (phase === 'stopping') {
    // Pressed again while stopping: reset right now.
    await link.sendRealtime(0x18).catch(() => undefined);
    return;
  }
  if (isActivePhase(phase)) {
    // The Rust job engine does hold → wait for stop (≤ 800 ms) → reset, and
    // flushes the queue under its lock so nothing is sent after the reset.
    try {
      await backend.jobStop();
      return;
    } catch {
      /* fall back to the manual sequence below */
    }
  }
  try {
    await link.sendRealtime(0x21); // '!'
  } catch {
    /* still try the reset */
  }
  const started = Date.now();
  await new Promise<void>((resolve) => {
    const check = () => {
      const st = useLink.getState().status?.state;
      const stopped = st && ((st.name === 'hold' && st.sub === 0) || st.name === 'idle' || st.name === 'alarm');
      if (stopped || Date.now() - started > STOP_RESET_TIMEOUT_MS) resolve();
      else setTimeout(check, 20);
    };
    setTimeout(check, 50);
  });
  try {
    await useLink.getState().sendRealtime(0x18);
  } catch (e) {
    sysMessage(`Reset could not be sent: ${String(e)}. Use your hardware E-stop.`, 'error');
  }
}

export function StopButton() {
  const state = useLink((s) => s.state);
  const disabled = state === 'disconnected';

  const extra = useApp((s) => bindings(s.settings.shortcuts).get('stop.extra') ?? null);
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape' && (!extra || keyName(e) !== extra)) return;
    if (isMotionState(useLink.getState().status)) {
      e.preventDefault();
      e.stopPropagation();
      void emergencyStop();
    }
  }, [extra]);

  useEffect(() => {
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onKey]);

  return (
    <Tip
      side="bottom"
      content={
        <span>
          Feed hold + reset (shortcut: <kbd>Esc</kbd>
          {extra ? (
            <>
              {' '}
              or <kbd>{displayKey(extra)}</kbd>
            </>
          ) : null}{' '}
          while moving).
          <br />
          <strong>Not a substitute for a hardware E-stop.</strong>
        </span>
      }
    >
      <Button data-testid="stop-button" variant="destructive" size="lg" disabled={disabled} onClick={() => void emergencyStop()} className="h-10 px-5 font-bold tracking-wide">
        <OctagonX className="size-5!" /> Stop
      </Button>
    </Tip>
  );
}
