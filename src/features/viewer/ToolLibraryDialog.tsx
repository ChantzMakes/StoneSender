/** Tool library editor (spec §6c): tools used by the material-removal simulation. Saved with the app settings. */
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/primitives';
import type { Units } from '@/lib/profile/schema';
import { fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { defaultTools, TOOL_KIND_LABEL, toolId, ToolSchema, type Tool, type ToolKind } from '@/lib/sim/tools';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';

type Draft = Record<'number' | 'name' | 'diameter' | 'fluteLength' | 'stickout' | 'angle' | 'tipDiameter' | 'holderDiameter', string> & { kind: ToolKind };

const LENGTH_FIELDS = ['diameter', 'fluteLength', 'stickout', 'tipDiameter', 'holderDiameter'] as const;

function toDraft(t: Tool, units: Units): Draft {
  const d = (mm: number) => String(roundForDisplay(toDisplay(mm, 'length', units), 'length', units));
  return {
    number: String(t.number),
    name: t.name,
    kind: t.kind,
    diameter: d(t.diameter),
    fluteLength: d(t.fluteLength),
    stickout: d(t.stickout),
    angle: String(t.angle),
    tipDiameter: d(t.tipDiameter),
    holderDiameter: d(t.holderDiameter),
  };
}

function fromDraft(id: string, d: Draft, units: Units): Tool | string {
  const n = (v: string) => Number(v.replace(',', '.'));
  const raw: Record<string, unknown> = { id, name: d.name.trim(), kind: d.kind, number: n(d.number), angle: n(d.angle) };
  for (const k of LENGTH_FIELDS) raw[k] = fromDisplay(n(d[k]), 'length', units);
  const r = ToolSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    return `${issue.path.join('.') || 'tool'}: ${issue.message}`;
  }
  return r.data;
}

export function ToolLibraryDialog({ open, onOpenChange, units }: { open: boolean; onOpenChange: (o: boolean) => void; units: Units }) {
  const tools = useApp((s) => s.settings.tools);
  const update = useApp((s) => s.update);
  const [list, setList] = useState<Tool[]>(tools);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const u = unitLabel('length', units);

  useEffect(() => {
    if (open) {
      setList(tools);
      setSel(tools[0]?.id ?? null);
      setDraft(tools[0] ? toDraft(tools[0], units) : null);
      setError(null);
    }
    // only when opened
  }, [open]);

  /** Commit the edited draft into the list; returns the updated list or null on error. */
  const commit = (): Tool[] | null => {
    if (!sel || !draft) return list;
    const t = fromDraft(sel, draft, units);
    if (typeof t === 'string') {
      setError(t);
      return null;
    }
    setError(null);
    const next = list.map((x) => (x.id === sel ? t : x));
    setList(next);
    return next;
  };

  const select = (id: string) => {
    const next = commit();
    if (!next) return;
    setSel(id);
    setDraft(toDraft(next.find((t) => t.id === id)!, units));
  };

  const add = (base?: Tool) => {
    const next = commit();
    if (!next) return;
    const number = Math.min(255, Math.max(0, ...next.map((t) => t.number)) + 1);
    const t: Tool = base ? { ...base, id: toolId(), number, name: `${base.name} (copy)`.slice(0, 60) } : ToolSchema.parse({ id: toolId(), number, name: 'New tool', kind: 'flat', diameter: 3, fluteLength: 12, stickout: 20 });
    setList([...next, t]);
    setSel(t.id);
    setDraft(toDraft(t, units));
  };

  const remove = () => {
    if (!sel || list.length <= 1) return;
    const next = list.filter((t) => t.id !== sel);
    setList(next);
    setSel(next[0]!.id);
    setDraft(toDraft(next[0]!, units));
    setError(null);
  };

  const field = (key: keyof Draft, label: string, unit?: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`tool-${key}`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={`tool-${key}`} className={key === 'name' ? '' : 'tabular text-right'} value={draft![key]} onChange={(e) => setDraft({ ...draft!, [key]: e.target.value })} />
        {unit && <span className="w-8 text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );

  const kind = draft?.kind;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Tool library</DialogTitle>
          <DialogDescription>Shapes and lengths the material simulation uses. Flute length, stick-out and holder diameter drive the flute and holder collision checks.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[220px_1fr] gap-4">
          <div className="flex min-h-0 flex-col gap-1">
            <div className="flex max-h-80 flex-col overflow-y-auto rounded-md border" data-testid="tool-list">
              {list.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => select(t.id)}
                  className={cn('flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent', t.id === sel && 'bg-accent')}
                >
                  <span className="tabular w-8 text-muted-foreground">T{t.number}</span>
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => add()} data-testid="tool-add">
                <Plus /> Add
              </Button>
              <Button size="sm" variant="ghost" disabled={!sel} onClick={() => add(list.find((t) => t.id === sel))} aria-label="Duplicate tool">
                <Copy />
              </Button>
              <Button size="sm" variant="ghost" disabled={!sel || list.length <= 1} onClick={remove} aria-label="Delete tool">
                <Trash2 />
              </Button>
            </div>
          </div>
          {draft && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-[90px_1fr] gap-3">
                {field('number', 'T number')}
                {field('name', 'Name')}
              </div>
              <div className="flex flex-col gap-1">
                <Label>Shape</Label>
                <Select aria-label="Tool shape" value={draft.kind} options={(Object.keys(TOOL_KIND_LABEL) as ToolKind[]).map((k) => ({ value: k, label: TOOL_KIND_LABEL[k] }))} onValueChange={(v) => setDraft({ ...draft, kind: v as ToolKind })} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {field('diameter', 'Diameter', u)}
                {field('fluteLength', 'Flute length', u)}
                {field('stickout', 'Stick-out', u)}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(kind === 'vbit' || kind === 'engraver' || kind === 'drill') && field('angle', kind === 'drill' ? 'Point angle' : 'Included angle', '°')}
                {kind === 'engraver' && field('tipDiameter', 'Tip diameter', u)}
                {field('holderDiameter', 'Collet nut / holder Ø', u)}
              </div>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              const d = defaultTools();
              setList(d);
              setSel(d[0]!.id);
              setDraft(toDraft(d[0]!, units));
              setError(null);
            }}
          >
            Restore default tools
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="tool-save"
            onClick={() => {
              const next = commit();
              if (!next) return;
              const nums = next.map((t) => t.number);
              if (new Set(nums).size !== nums.length) {
                setError('Two tools share a T number. Give each tool its own number.');
                return;
              }
              update((s) => ({ ...s, tools: next }));
              onOpenChange(false);
            }}
          >
            Save library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
