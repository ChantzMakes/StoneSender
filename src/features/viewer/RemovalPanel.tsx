/** Overlay for the material-removal simulation: progress, result stats, problems, export. */
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { backend } from '@/lib/backend';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, toDisplay, unitLabel } from '@/lib/profile/units';
import { burnPng, heightfieldStl, rotaryStl } from '@/lib/sim/export';
import type { ProblemKind, SimEvent } from '@/lib/sim/removal';
import { errorMessage } from '@/lib/utils';
import { buffers, fullGrid, useRemoval } from '@/store/removal';
import { useLink } from '@/store/link';
import { useSim } from '@/store/sim';
import { BURN_K } from './RemovalView';

const LABEL: Record<ProblemKind, string> = {
  'rapid-gouge': 'Rapid move cuts material',
  'below-stock': 'Cuts below the stock',
  flute: 'Cut deeper than the flute length',
  holder: 'Collet / holder hits the material',
  island: 'Small island of material left',
};
const COLOR: Record<ProblemKind, string> = { 'rapid-gouge': 'text-red-500', 'below-stock': 'text-fuchsia-400', flute: 'text-amber-500', holder: 'text-orange-400', island: 'text-yellow-500' };

function summarize(events: SimEvent[]) {
  const by = new Map<ProblemKind, { count: number; line: number }>();
  for (const e of events) {
    const g = by.get(e.kind) ?? { count: 0, line: e.line };
    g.count++;
    if (e.line > 0 && (g.line === 0 || e.line < g.line)) g.line = e.line;
    by.set(e.kind, g);
  }
  return [...by.entries()];
}

export async function exportResult(stockColor: string): Promise<string | null> {
  const r = await fullGrid();
  const cfg = buffers.config;
  if (!r || !cfg) return 'Nothing to export yet.';
  const name = (useLink.getState().loadedJob?.name ?? 'job').replace(/\.[^.]+$/, '');
  if (cfg.mode === 'laser') {
    const bytes = burnPng(r.grid, r.data, stockColor, BURN_K);
    await backend.saveBinaryFile({ title: 'Export burn preview', defaultName: `${name}-burn.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], bytes, mime: 'image/png' });
  } else {
    const bytes = cfg.mode === 'rotary' ? rotaryStl(r.grid, r.data, name) : heightfieldStl(r.grid, r.data, cfg.stockMin[2], name);
    await backend.saveBinaryFile({ title: 'Export simulated part', defaultName: `${name}-result.stl`, filters: [{ name: 'STL mesh', extensions: ['stl'] }], bytes, mime: 'model/stl' });
  }
  return null;
}

export function RemovalPanel({ profile, stockColor }: { profile: MachineProfile; stockColor: string }) {
  const { status, progress, error, events, stats, mode, grid, shownTime } = useRemoval();
  const showRemoval = useSim((s) => s.showRemoval);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const units = profile.units;
  const u = unitLabel('length', units);
  if (!showRemoval || status === 'idle') return null;
  if (status === 'running') {
    return (
      <div className="pointer-events-none absolute top-12 left-2 z-30 rounded-md bg-card/85 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur" data-testid="removal-status">
        Simulating material removal… {Math.round(progress * 100)}%
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="absolute top-12 left-2 z-30 max-w-xs rounded-md border border-destructive/40 bg-card/90 px-2 py-1 text-[11px] text-destructive" data-testid="removal-status">
        Material simulation failed: {error}
      </div>
    );
  }
  const atEnd = stats ? shownTime >= stats.totalTime - 1e-6 : false;
  const groups = summarize(events);
  const vol = stats ? toDisplay(stats.removedVolume / 1000, 'length', 'mm') : 0;
  return (
    <div className="absolute top-12 left-2 z-30 flex max-w-xs flex-col gap-0.5 rounded-md border bg-card/90 px-2 py-1 text-[11px] backdrop-blur" data-testid="removal-status">
      <span className="font-medium">
        {mode === 'laser' ? 'Burn simulation' : 'Material removal'} {atEnd ? '· final result' : '· follows playback'}
      </span>
      {grid && (
        <span className="text-muted-foreground">
          Resolution {formatLength(grid.res, units, units === 'inch' ? 4 : 2)} {u}
          {stats && mode !== 'laser' && ` · removed ${units === 'inch' ? (vol / 16.387).toFixed(2) + ' in³' : vol.toFixed(1) + ' cm³'}`}
          {stats && mode === 'router' && Number.isFinite(stats.minHeight) && ` · deepest Z ${formatLength(stats.minHeight, units, 2)}`}
        </span>
      )}
      {groups.length === 0 ? (
        <span className="text-green-600 dark:text-green-400" data-testid="removal-ok">
          ✓ No gouges, holder or flute problems found
        </span>
      ) : (
        groups.map(([k, g]) => (
          <span key={k} className={COLOR[k]} data-testid={`removal-problem-${k}`}>
            ● {LABEL[k]}
            {g.count > 1 ? ` (${g.count}${g.count >= 200 ? '+' : ''})` : ''}
            {g.line > 0 ? `, first at line ${g.line}` : ''}
          </span>
        ))
      )}
      <Button
        size="sm"
        variant="secondary"
        className="mt-1 h-6 self-start px-2 text-[11px]"
        disabled={busy}
        data-testid="removal-export"
        onClick={async () => {
          setBusy(true);
          setExportError(null);
          try {
            setExportError(await exportResult(stockColor));
          } catch (e) {
            setExportError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download className="size-3" />
        {mode === 'laser' ? 'Export PNG' : 'Export STL'}
        {!atEnd && ' (at this point)'}
      </Button>
      {exportError && <span className="text-destructive">{exportError}</span>}
    </div>
  );
}
