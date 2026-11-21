/**
 * Global keyboard shortcuts (Phase 8). STOP lives in StopButton (capture
 * phase, works everywhere while moving) and jog keys in JogPanel (only with
 * the session's keyboard-jog switch on); this handles the rest. Nothing here
 * can start motion: see lib/shortcuts.ts.
 */
import { useEffect } from 'react';
import { backend } from '@/lib/backend';
import { actionFor, JOG_SHORTCUTS, keyName } from '@/lib/shortcuts';
import { errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { useUi } from '@/store/ui';

/** Typing into a field, the editor or a menu: shortcuts keep out of the way. */
export function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest?.('[role="dialog"],[role="listbox"],[role="menu"],.monaco-editor'));
}

function run(p: Promise<unknown> | void) {
  if (p) p.catch((e: unknown) => sysMessage(errorMessage(e), 'error'));
}

export function feedHold() {
  const link = useLink.getState();
  if (link.state !== 'connected') return;
  if (isActivePhase(link.job?.phase)) run(backend.jobPause());
  else run(link.sendRealtime(0x21));
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const name = keyName(e);
      if (!name) return;
      const id = actionFor(name, useApp.getState().settings.shortcuts);
      if (!id || id === 'stop' || id === 'stop.extra' || JOG_SHORTCUTS[id] || id === 'jog.stepUp' || id === 'jog.stepDown') return;
      // Help works from anywhere; pausing works from anywhere outside text fields.
      const inText = !!(e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable="true"],.monaco-editor');
      if (id === 'feedHold' ? inText : id !== 'help' && isTypingTarget(e.target)) return;
      e.preventDefault();
      const ui = useUi.getState();
      const app = useApp.getState();
      switch (id) {
        case 'help':
          ui.openHelp();
          break;
        case 'preferences':
          ui.openPrefs();
          break;
        case 'feedHold':
          feedHold();
          break;
        case 'file.open':
          run(useLink.getState().openJob());
          break;
        case 'view.toggle':
          app.update((s) => ({ ...s, centerTab: s.centerTab === 'view' ? 'editor' : 'view' }));
          break;
        case 'view.console':
          app.update((s) => ({ ...s, layout: { ...s.layout, preset: 'custom', show: { ...s.layout.show, console: !s.layout.show.console } } }));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
