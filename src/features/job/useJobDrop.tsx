/**
 * Drop a G-code file anywhere on the window to load it.
 * Desktop: Tauri reports file paths (HTML5 drop events don't carry files in
 * the webview). Browser preview: regular HTML5 drag and drop.
 */
import { useEffect, useState } from 'react';
import { isTauri } from '@/lib/backend';
import { errorMessage } from '@/lib/utils';
import { sysMessage } from '@/store/console';
import { useLink } from '@/store/link';

const GCODE_EXT = /\.(nc|gcode|gc|ngc|tap|cnc|txt)$/i;

export function useJobDrop(): boolean {
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (isTauri) {
      let un: (() => void) | undefined;
      let cancelled = false;
      void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent((e) => {
            const p = e.payload;
            if (p.type === 'enter' || p.type === 'over') setOver(true);
            else if (p.type === 'leave') setOver(false);
            else if (p.type === 'drop') {
              setOver(false);
              const path = p.paths.find((x) => GCODE_EXT.test(x));
              if (!path) return sysMessage('That file type is not G-code (.nc, .gcode, .ngc, .tap…).', 'warn');
              useLink
                .getState()
                .loadJobPath(path)
                .catch((err) => sysMessage(errorMessage(err), 'error'));
            }
          })
          .then((f) => {
            if (cancelled) f();
            else un = f;
          }),
      );
      return () => {
        cancelled = true;
        un?.();
      };
    }
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setOver(true);
      }
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      setOver(false);
      if (!GCODE_EXT.test(file.name)) return sysMessage('That file type is not G-code (.nc, .gcode, .ngc, .tap…).', 'warn');
      void file
        .text()
        .then((text) => useLink.getState().loadJobText(file.name, text))
        .catch((err) => sysMessage(errorMessage(err), 'error'));
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return over;
}
