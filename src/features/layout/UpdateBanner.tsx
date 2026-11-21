/** "A new version is available" banner + the quiet startup check (Phase 8b). */
import { Download, X } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/primitives';
import { isTauri } from '@/lib/backend';
import { useApp } from '@/store/app';
import { useLink } from '@/store/link';
import { useUi } from '@/store/ui';
import { useUpdates } from '@/store/updates';

/** Mount once (App): checks github.com a few seconds after start, if allowed. */
export function useStartupUpdateCheck() {
  const loaded = useApp((s) => s.loaded);
  const enabled = useApp((s) => s.settings.updates.checkOnStartup);
  useEffect(() => {
    if (!loaded || !enabled || !isTauri || import.meta.env.DEV) return;
    const t = setTimeout(() => void useUpdates.getState().check({ quiet: true }), 5000);
    return () => clearTimeout(t);
  }, [loaded, enabled]);
}

export function UpdateBanner() {
  const { status, version, dismissed, progress, error } = useUpdates();
  const connected = useLink((s) => s.state !== 'disconnected');
  const openPrefs = useUi((s) => s.openPrefs);
  const show = (status === 'available' && dismissed !== version) || status === 'downloading' || status === 'installing';
  if (!show) return null;
  return (
    <div role="status" data-testid="update-banner" className="flex items-center gap-3 border-b border-primary/40 bg-primary/10 px-4 py-2 text-sm">
      <Download className="size-4 text-primary" />
      <div className="flex-1">
        {status === 'available' && (
          <>
            <strong>StoneSender {version} is available.</strong>{' '}
            <button type="button" className="text-primary underline" onClick={() => openPrefs('about')}>
              What's new
            </button>
            {connected && <span className="text-muted-foreground"> — disconnect from the machine to install it (the app restarts).</span>}
            {error && <span className="text-destructive"> {error}</span>}
          </>
        )}
        {status === 'downloading' && <>Downloading StoneSender {version}… {progress != null ? `${Math.round(progress * 100)} %` : ''}</>}
        {status === 'installing' && <>Installing StoneSender {version} — the app restarts in a moment.</>}
      </div>
      {status === 'available' && (
        <>
          <Tip content={connected ? 'Disconnect first: installing restarts the app.' : 'Download, install and restart'}>
            <span>
              <Button size="sm" disabled={connected} onClick={() => void useUpdates.getState().install()} data-testid="update-install">
                Install and restart
              </Button>
            </span>
          </Tip>
          <Button variant="ghost" size="icon-sm" aria-label="Later" onClick={() => useUpdates.getState().dismiss()}>
            <X />
          </Button>
        </>
      )}
    </div>
  );
}
