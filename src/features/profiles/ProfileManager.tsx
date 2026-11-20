/** Profile manager dialog: list, edit, duplicate, rename, delete, import, export. */
import { Copy, Download, Pencil, Plus, Star, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Badge, Input } from '@/components/ui/primitives';
import type { ImportResult } from '@/lib/profile/share';
import { cn, errorMessage } from '@/lib/utils';
import { useLink } from '@/store/link';
import { useProfiles } from '@/store/profiles';
import { MachineTypeArt } from '../wizard/diagrams';
import { ImportReviewDialog } from './ImportReviewDialog';
import { ProfileEditor } from './ProfileEditor';

export function ProfileManager({ open, onOpenChange, onNewProfile }: { open: boolean; onOpenChange: (o: boolean) => void; onNewProfile: () => void }) {
  const { profiles, activeId, setActive, duplicate, rename, remove, exportToFile, importFromFile } = useProfiles();
  const connectedProfileId = useLink((s) => (s.state === 'disconnected' ? null : s.connectedProfileId));
  const [selectedId, setSelectedId] = useState<string | null>(activeId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) setSelectedId((id) => (id && profiles.some((p) => p.id === id) ? id : activeId));
  }, [open, activeId, profiles]);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  const toDelete = profiles.find((p) => p.id === confirmDelete);

  const run = async (f: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="h-[85vh] max-w-6xl gap-0 p-0">
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-72 shrink-0 flex-col border-r">
              <div className="border-b p-4">
                <DialogTitle>Machine profiles</DialogTitle>
                <DialogDescription>One profile per machine. Share them as files.</DialogDescription>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {profiles.map((p) => (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(p.id)}
                    onKeyDown={(e) => e.key === 'Enter' && setSelectedId(p.id)}
                    className={cn('group flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-accent', selectedId === p.id && 'bg-accent')}
                  >
                    {p.identity.icon ? <span className="w-10 text-center text-xl">{p.identity.icon}</span> : <MachineTypeArt type={p.machineType} className="h-8 w-10 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      {renaming === p.id ? (
                        <Input
                          autoFocus
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && renameText.trim()) run(() => rename(p.id, renameText)).then(() => setRenaming(null));
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={() => setRenaming(null)}
                          className="h-7"
                        />
                      ) : (
                        <div className="truncate text-sm font-medium">{p.identity.name}</div>
                      )}
                      <div className="flex gap-1">
                        {p.id === activeId && <Badge variant="info">active</Badge>}
                        {p.id === connectedProfileId && <Badge variant="success">connected</Badge>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2 border-t p-3">
                <Button onClick={onNewProfile}>
                  <Plus /> New profile…
                </Button>
                <Button
                  variant="outline"
                  data-testid="import-profile"
                  onClick={() =>
                    run(async () => {
                      const r = await importFromFile();
                      if (r) setImportResult(r);
                    })
                  }
                >
                  <Upload /> Import from file…
                </Button>
              </div>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col">
              {selected ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b p-3 pr-12">
                    <h3 className="mr-auto truncate text-lg font-semibold">{selected.identity.name}</h3>
                    <Button size="sm" variant={selected.id === activeId ? 'secondary' : 'default'} disabled={selected.id === activeId} onClick={() => setActive(selected.id)}>
                      <Star /> {selected.id === activeId ? 'Active' : 'Use this profile'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRenaming(selected.id);
                        setRenameText(selected.identity.name);
                      }}
                    >
                      <Pencil /> Rename
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => run(async () => setSelectedId((await duplicate(selected.id)).id))}>
                      <Copy /> Duplicate
                    </Button>
                    <Button size="sm" variant="outline" data-testid="export-profile" onClick={() => run(() => exportToFile(selected.id))}>
                      <Download /> Export
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" disabled={selected.id === connectedProfileId} onClick={() => setConfirmDelete(selected.id)}>
                      <Trash2 /> Delete
                    </Button>
                  </div>
                  {message && <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{message}</div>}
                  <ProfileEditor profile={selected} />
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No profile selected.</div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete “${toDelete?.identity.name}”?`}
        description={
          <>
            This removes the profile from this computer. It cannot be undone — export it first if you might want it back. Your controller's own settings are not affected.
          </>
        }
        confirmLabel="Delete profile"
        destructive
        onConfirm={() => run(() => remove(toDelete!.id))}
      />
      <ImportReviewDialog result={importResult} onClose={() => setImportResult(null)} />
    </>
  );
}
