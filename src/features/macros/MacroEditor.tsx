/** Create, edit, reorder and delete macros. Saved with the app settings. */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/primitives';
import { type Macro, macroId, macroProblems, MacroSchema } from '@/lib/macros';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';

export function MacroEditor({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const saved = useApp((s) => s.settings.macros);
  const update = useApp((s) => s.update);
  const [list, setList] = useState<Macro[]>(saved);
  const [sel, setSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setList(saved);
      setSel(saved[0]?.id ?? null);
      setError(null);
    }
  }, [open]);

  const cur = list.find((m) => m.id === sel) ?? null;
  const patch = (p: Partial<Macro>) => setList(list.map((m) => (m.id === sel ? { ...m, ...p } : m)));
  const move = (d: -1 | 1) => {
    const i = list.findIndex((m) => m.id === sel);
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setList(next);
  };
  const problems = cur ? macroProblems(cur) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Macros</DialogTitle>
          <DialogDescription>
            G-code sent line by line when you click the button. Use <code>{'{name}'}</code> or <code>{'{name=default}'}</code> for values asked each time, and <code>{'{wx} {wy} {wz}'}</code> (work position), <code>{'{mx} {my} {mz}'}</code> (machine position), <code>{'{safeZ}'}</code>, <code>{'{clearance}'}</code> (from your profile) — all in mm. Settings writes ($n=) are not allowed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[200px_1fr] gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex max-h-80 flex-col overflow-y-auto rounded-md border">
              {list.map((m) => (
                <button key={m.id} type="button" onClick={() => setSel(m.id)} className={cn('truncate px-2 py-1.5 text-left text-xs hover:bg-accent', m.id === sel && 'bg-accent')}>
                  {m.name}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="secondary"
                data-testid="macro-add"
                onClick={() => {
                  const m: Macro = { id: macroId(), name: 'New macro', gcode: 'G21\n', description: '' };
                  setList([...list, m]);
                  setSel(m.id);
                }}
              >
                <Plus /> Add
              </Button>
              <Button size="sm" variant="ghost" disabled={!cur} onClick={() => move(-1)} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button size="sm" variant="ghost" disabled={!cur} onClick={() => move(1)} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!cur}
                aria-label="Delete macro"
                onClick={() => {
                  const next = list.filter((m) => m.id !== sel);
                  setList(next);
                  setSel(next[0]?.id ?? null);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {cur ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="macro-name">Button label</Label>
                  <Input id="macro-name" value={cur.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="macro-desc">Description</Label>
                  <Input id="macro-desc" value={cur.description} maxLength={200} onChange={(e) => patch({ description: e.target.value })} />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="macro-gcode">G-code</Label>
                <Textarea id="macro-gcode" className="h-48 font-mono text-xs" value={cur.gcode} onChange={(e) => patch({ gcode: e.target.value })} spellCheck={false} />
              </div>
              {problems.map((p, i) => (
                <p key={i} className="text-xs text-destructive">
                  {p}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Add a macro to get started.</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="macro-save"
            onClick={() => {
              for (const m of list) {
                const r = MacroSchema.safeParse(m);
                if (!r.success) return setError(`“${m.name || 'unnamed'}”: ${r.error.issues[0]?.message}`);
                if (!m.name.trim()) return setError('Every macro needs a label.');
              }
              update((s) => ({ ...s, macros: list.map((m) => ({ ...m, name: m.name.trim() })) }));
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
