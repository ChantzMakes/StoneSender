/**
 * Imported macros are shown in full before they are added (like imported
 * profiles): the user reads each one and ticks it. Importing never sends
 * anything to the machine.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type Macro, macroProblems } from '@/lib/macros';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';

export function MacroImportReview({ macros, onClose }: { macros: Macro[] | null; onClose: () => void }) {
  const update = useApp((s) => s.update);
  const existing = useApp((s) => s.settings.macros);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [macros]);
  if (!macros) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review imported macros</DialogTitle>
          <DialogDescription>Read each macro before adding it — it will move your machine when clicked. Nothing is sent now.</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto" data-testid="macro-review">
          {macros.map((m) => {
            const problems = macroProblems(m);
            const clash = existing.some((e) => e.name === m.name);
            return (
              <li key={m.id} className="rounded-md border p-2 text-sm">
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    disabled={problems.length > 0}
                    checked={picked.has(m.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      setPicked(next);
                    }}
                    data-testid={`macro-pick-${m.name}`}
                  />
                  {m.name}
                  {clash && <span className="text-xs font-normal text-warning">(you already have one with this name)</span>}
                </label>
                {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
                <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-muted p-2 text-xs">{m.gcode}</pre>
                {problems.map((p, i) => (
                  <p key={i} className="text-xs text-destructive">
                    {p}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={picked.size === 0}
            data-testid="macro-import-confirm"
            onClick={() => {
              const add = macros.filter((m) => picked.has(m.id));
              update((s) => ({ ...s, macros: [...s.macros, ...add] }));
              sysMessage(`Added ${add.length} macro(s).`);
              onClose();
            }}
          >
            Add {picked.size} macro(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
