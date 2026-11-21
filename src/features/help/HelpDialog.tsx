/**
 * In-app help (Phase 8): the user guide (docs/USER_GUIDE.md, bundled at build
 * time) with contents and search, the keyboard shortcuts, and the controller
 * error / alarm explanations. Opened with F1, the header's "?" or the small
 * "?" buttons next to panels (at their section).
 */
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import guide from '../../../docs/USER_GUIDE.md?raw';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { ALARMS, ERRORS } from '@/lib/grbl/codes';
import { type Block, blockText, parseMarkdown, sections } from '@/lib/markdown';
import { bindings, displayKey, SHORTCUTS, type ShortcutGroup } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useApp } from '@/store/app';
import { useUi } from '@/store/ui';
import { Markdown } from './Markdown';

const BLOCKS = parseMarkdown(guide);
const SECTIONS = sections(BLOCKS);

/** Blocks grouped by level-2/3 section (for search). */
function bySection(blocks: Block[]): { id: string; blocks: Block[] }[] {
  const out: { id: string; blocks: Block[] }[] = [{ id: '', blocks: [] }];
  for (const b of blocks) {
    if (b.t === 'h' && b.level >= 2 && b.level <= 3) out.push({ id: b.id, blocks: [] });
    out[out.length - 1]!.blocks.push(b);
  }
  return out;
}
const GROUPS = bySection(BLOCKS);

export function HelpDialog() {
  const { open, section } = useUi((s) => s.help);
  const close = useUi((s) => s.closeHelp);
  const [tab, setTab] = useState('guide');
  const [query, setQuery] = useState('');
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setTab('guide');
    setQuery('');
    // Wait for the dialog to render, then jump to the section.
    const t = setTimeout(() => {
      const el = section ? body.current?.querySelector(`#help-${CSS.escape(section)}`) : null;
      if (el) el.scrollIntoView({ block: 'start' });
      else body.current?.scrollTo({ top: 0 });
    }, 30);
    return () => clearTimeout(t);
  }, [open, section]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return BLOCKS;
    return GROUPS.filter((g) => g.id && g.blocks.some((b) => blockText(b).toLowerCase().includes(q))).flatMap((g) => g.blocks);
  }, [q]);
  const hits = new Set(q ? GROUPS.filter((g) => g.id && g.blocks.some((b) => blockText(b).toLowerCase().includes(q))).map((g) => g.id) : []);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col" data-testid="help-dialog">
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
          <DialogDescription>How to use the app with your machine. Press F1 any time to come back here.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="guide">User guide</TabsTrigger>
            <TabsTrigger value="shortcuts" data-testid="help-tab-shortcuts">
              Keyboard shortcuts
            </TabsTrigger>
            <TabsTrigger value="codes" data-testid="help-tab-codes">
              Error and alarm codes
            </TabsTrigger>
          </TabsList>
          <TabsContent value="guide" className="mt-3 flex min-h-0 flex-1 gap-4">
            <nav className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto text-sm">
              <div className="relative">
                <Search className="absolute top-2 left-2 size-4 text-muted-foreground" />
                <Input className="h-8 pl-8" placeholder="Search the guide" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="help-search" />
              </div>
              <ul className="flex flex-col">
                {SECTIONS.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={cn('w-full rounded px-2 py-1 text-left hover:bg-accent', s.level === 3 && 'pl-5 text-muted-foreground', q && !hits.has(s.id) && 'opacity-40')}
                      onClick={() => {
                        setQuery('');
                        setTimeout(() => body.current?.querySelector(`#help-${CSS.escape(s.id)}`)?.scrollIntoView({ block: 'start' }), 0);
                      }}
                    >
                      {s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <div ref={body} className="selectable min-h-0 flex-1 overflow-y-auto pr-3 text-sm" data-testid="help-body">
              {shown.length ? <Markdown blocks={shown} /> : <p className="text-muted-foreground">Nothing in the guide matches “{query}”.</p>}
            </div>
          </TabsContent>
          <TabsContent value="shortcuts" className="mt-3 min-h-0 flex-1 overflow-y-auto">
            <ShortcutList />
          </TabsContent>
          <TabsContent value="codes" className="mt-3 min-h-0 flex-1 overflow-y-auto">
            <CodeList />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutList() {
  const overrides = useApp((s) => s.settings.shortcuts);
  const keys = bindings(overrides);
  const openPrefs = useUi((s) => s.openPrefs);
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))] as ShortcutGroup[];
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="help-shortcuts">
      <p className="text-muted-foreground">
        Jog keys only work while <strong>Keys</strong> is switched on in the Jog panel (it is off every time the app starts). Change keys in{' '}
        <button type="button" className="text-primary underline" onClick={() => openPrefs('shortcuts')}>
          Preferences → Shortcuts
        </button>
        .
      </p>
      {groups.map((g) => (
        <div key={g}>
          <h3 className="mb-1 font-semibold">{g}</h3>
          <table className="w-full text-left">
            <tbody>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="py-1 pr-4">{s.label}</td>
                  <td className="w-40 py-1">
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{displayKey(keys.get(s.id) ?? null)}</kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function CodeList() {
  const [q, setQ] = useState('');
  const match = (n: number, c: { title: string; meaning: string; fix: string }) => !q || `${n} ${c.title} ${c.meaning} ${c.fix}`.toLowerCase().includes(q.toLowerCase());
  const list = (kind: 'error' | 'ALARM', table: typeof ERRORS) => (
    <ul className="flex flex-col gap-2">
      {Object.entries(table)
        .filter(([n, c]) => match(Number(n), c))
        .map(([n, c]) => (
          <li key={n} className="rounded-md border p-2">
            <div className="font-medium">
              <span className="font-mono">
                {kind}:{n}
              </span>{' '}
              — {c.title}
            </div>
            <div className="text-muted-foreground">{c.meaning}</div>
            <div className="mt-0.5">
              <span className="font-medium">What to do:</span> {c.fix}
            </div>
          </li>
        ))}
    </ul>
  );
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="help-codes">
      <p className="text-muted-foreground">The console shows these when the controller reports a problem. They are explained there too.</p>
      <Input className="h-8 max-w-xs" placeholder="Search, e.g. 9 or soft limit" value={q} onChange={(e) => setQ(e.target.value)} />
      <h3 className="font-semibold">Alarms</h3>
      {list('ALARM', ALARMS)}
      <h3 className="font-semibold">Errors</h3>
      {list('error', ERRORS)}
    </div>
  );
}
