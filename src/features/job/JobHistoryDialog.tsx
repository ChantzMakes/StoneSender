import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { useApp } from '@/store/app';
import { formatDuration } from './format';

export function JobHistoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const history = useApp((s) => s.settings.jobHistory);
  const update = useApp((s) => s.update);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Job history</DialogTitle>
          <DialogDescription>The last {history.length} jobs and checks run on this computer.</DialogDescription>
        </DialogHeader>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto text-sm" data-testid="job-history">
            {history.map((h, i) => (
              <li key={i} className="flex items-center gap-2 rounded-md border p-2">
                <Badge variant={h.outcome === 'completed' ? 'success' : h.outcome === 'stopped' ? 'secondary' : 'destructive'}>{h.mode === 'check' ? `check ${h.outcome}` : h.outcome}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{h.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(h.finishedAt).toLocaleString()} · {h.profile} · {formatDuration(h.elapsedMs)} · {h.lines.toLocaleString()} lines
                    {h.errors ? ` · ${h.errors} error(s)` : ''}
                  </div>
                  {h.message && <div className="text-xs text-muted-foreground">{h.message}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {history.length > 0 && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => update((s) => ({ ...s, jobHistory: [] }))}>
              Clear history
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
