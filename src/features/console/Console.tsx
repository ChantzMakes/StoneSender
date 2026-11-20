/** Serial console with filters, command history (↑/↓) and autocomplete. */
import { ArrowDownToLine, Eraser, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, PanelTitle, Switch, Tip } from '@/components/ui/primitives';
import { cn, errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { type ConsoleEntry, sysMessage, useConsole } from '@/store/console';
import { useLink } from '@/store/link';

const SUGGESTIONS = [
  ['$$', 'View settings'],
  ['$#', 'View offsets (G54–G59, G28, G30, G92, TLO, PRB)'],
  ['$G', 'View parser state'],
  ['$I', 'View build info'],
  ['$N', 'View startup blocks'],
  ['$X', 'Clear alarm lock'],
  ['$H', 'Home'],
  ['$C', 'Toggle check mode'],
  ['$J=G91 X10 F1000', 'Jog example'],
  ['G0 X0 Y0', 'Rapid to work zero'],
  ['G90', 'Absolute distance'],
  ['G91', 'Incremental distance'],
  ['G21', 'Millimetres'],
  ['G20', 'Inches'],
  ['G10 L20 P1 X0 Y0 Z0', 'Set work zero here'],
  ['M5', 'Spindle off'],
  ['M9', 'Coolant off'],
] as const;

function entryClass(e: ConsoleEntry): string {
  if (e.dir === 'sys') return e.kind === 'error' ? 'text-destructive' : e.kind === 'warn' ? 'text-warning' : 'text-info';
  if (e.dir === 'tx') return 'text-primary';
  switch (e.kind) {
    case 'error':
    case 'alarm':
      return 'text-destructive font-semibold';
    case 'ok':
      return 'text-success/80';
    case 'message':
    case 'welcome':
      return 'text-info';
    case 'status':
      return 'text-muted-foreground/70';
    default:
      return 'text-foreground/90';
  }
}

export function Console() {
  const entries = useConsole((s) => s.entries);
  const history = useConsole((s) => s.history);
  const clear = useConsole((s) => s.clear);
  const filters = useApp((s) => s.settings.console);
  const update = useApp((s) => s.update);
  const connected = useLink((s) => s.state === 'connected');
  const queue = useLink((s) => s.queue);
  const sendLine = useLink((s) => s.sendLine);
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () =>
      entries.filter((e) => {
        if (filters.hideStatus && e.kind === 'status') return false;
        if (filters.hideOk && e.kind === 'ok') return false;
        if (!filters.showTx && e.dir === 'tx') return false;
        return true;
      }),
    [entries, filters],
  );

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  async function submit() {
    const line = input.trim();
    if (!line) return;
    try {
      await sendLine(line);
      setInput('');
      setHistIdx(-1);
    } catch (e) {
      sysMessage(errorMessage(e), 'error');
    }
  }

  const setFilter = (k: keyof typeof filters, v: boolean) => update((s) => ({ ...s, console: { ...s.console, [k]: v } }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelTitle
        actions={
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Status <Switch checked={!filters.hideStatus} onCheckedChange={(c) => setFilter('hideStatus', !c)} aria-label="Show status reports" />
            </label>
            <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              ok <Switch checked={!filters.hideOk} onCheckedChange={(c) => setFilter('hideOk', !c)} aria-label="Show ok responses" />
            </label>
            <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              Sent <Switch checked={filters.showTx} onCheckedChange={(c) => setFilter('showTx', c)} aria-label="Show sent commands" />
            </label>
            <Tip content={follow ? 'Auto-scroll on' : 'Auto-scroll off'}>
              <Button variant={follow ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => setFollow(!follow)} aria-label="Toggle auto-scroll">
                <ArrowDownToLine />
              </Button>
            </Tip>
            <Tip content="Clear console">
              <Button variant="ghost" size="icon-sm" onClick={clear} aria-label="Clear console">
                <Eraser />
              </Button>
            </Tip>
          </>
        }
      >
        Console
      </PanelTitle>
      <div ref={scroller} className="selectable min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5" data-testid="console-log">
        {visible.length === 0 && <div className="text-muted-foreground">Nothing yet. Connect to a machine (or the virtual one) to see its messages here.</div>}
        {visible.map((e) => (
          <div key={e.id} className={cn('break-all whitespace-pre-wrap', entryClass(e))}>
            <span className="mr-2 text-muted-foreground/60">{e.dir === 'tx' ? '›' : e.dir === 'rx' ? '‹' : '•'}</span>
            {e.text}
          </div>
        ))}
      </div>
      <form
        className="flex items-center gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          list="console-suggestions"
          data-testid="console-input"
          placeholder={connected ? 'Type a command, e.g. $$ — ↑/↓ for history' : 'Connect first'}
          disabled={!connected}
          value={input}
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(histIdx + 1, history.length - 1);
              setHistIdx(i);
              setInput(history[i]!);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const i = histIdx - 1;
              setHistIdx(Math.max(i, -1));
              setInput(i >= 0 ? history[i]! : '');
            }
          }}
        />
        <datalist id="console-suggestions">
          {SUGGESTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </datalist>
        {queue.pending > 0 && <span className="text-xs text-muted-foreground tabular">{queue.pending} queued</span>}
        <Button type="submit" size="sm" disabled={!connected || !input.trim()}>
          <Send /> Send
        </Button>
      </form>
    </div>
  );
}
