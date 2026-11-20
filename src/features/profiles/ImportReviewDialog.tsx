/** Imported profiles are always shown for review before they can be used. */
import { AlertTriangle, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ImportResult } from '@/lib/profile/share';
import { errorMessage } from '@/lib/utils';
import { useProfiles } from '@/store/profiles';

export function ImportReviewDialog({ result, onClose }: { result: ImportResult | null; onClose: () => void }) {
  const save = useProfiles((s) => s.save);
  const setActive = useProfiles((s) => s.setActive);
  const [error, setError] = useState<string | null>(null);
  const [makeActive, setMakeActive] = useState(false);

  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Review imported profile</DialogTitle>
          <DialogDescription>Check that this matches your machine before using it.</DialogDescription>
        </DialogHeader>
        {result && !result.ok && (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <XCircle className="size-4" /> This file can't be imported
            </div>
            <ul className="list-disc pl-5">
              {Object.entries(result.errors).map(([k, v]) => (
                <li key={k}>
                  <code className="text-xs">{k}</code>: {v}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result?.ok && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-y-1.5 rounded-lg border p-3 text-sm">
              {result.facts.map((f) => (
                <div key={f.label} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{f.label}</span>
                  <span className="text-right font-medium">{f.value}</span>
                </div>
              ))}
            </div>
            {result.warnings.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4" /> No problems found.
              </div>
            ) : (
              result.warnings.map((w) => (
                <div key={w} className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <AlertTriangle className="size-4 shrink-0 text-warning" />
                  {w}
                </div>
              ))
            )}
            <div className="flex gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" />
              Importing only adds the profile to this app. No settings are sent to your controller — when you connect, you'll see any differences and confirm each change individually.
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} /> Switch to this profile after adding
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result?.ok ? 'Cancel' : 'Close'}
          </Button>
          {result?.ok && (
            <Button
              data-testid="import-confirm"
              onClick={async () => {
                try {
                  await save(result.profile);
                  if (makeActive) setActive(result.profile.id);
                  onClose();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Add profile
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
