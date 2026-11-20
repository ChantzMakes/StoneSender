/** Stock, tools and simulation resolution for the material-removal simulation and the pre-flight checks. */
import { Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/primitives';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { defaultStock, type StockOrigin, type StockSetup } from '@/lib/sim/setup';
import { resolveTool } from '@/lib/sim/tools';
import { useAnalysis } from '@/store/analysis';
import { useApp } from '@/store/app';
import { useSim } from '@/store/sim';
import { ToolLibraryDialog } from './ToolLibraryDialog';

const ORIGINS: { value: StockOrigin; label: string }[] = [
  { value: 'front-left-top', label: 'Front-left corner, top surface (most common)' },
  { value: 'center-top', label: 'Centre, top surface' },
  { value: 'front-left-bottom', label: 'Front-left corner, bottom (spoilboard)' },
];

const RESOLUTIONS = [0, 0.1, 0.2, 0.25, 0.5, 1];
const AUTO = '__auto';
const NO_TOOLS: never[] = [];

export function StockDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: MachineProfile }) {
  const stock = useSim((s) => s.stock) ?? defaultStock(profile);
  const jobTools = useSim((s) => s.jobTools);
  const defaultToolId = useSim((s) => s.defaultToolId);
  const tools = useApp((s) => s.settings.tools);
  const resolution = useApp((s) => s.settings.simResolution);
  const update = useApp((s) => s.update);
  const usedTools = useAnalysis((s) => s.result?.stats.tools) ?? NO_TOOLS;
  const units = profile.units;
  const u = unitLabel('length', units);
  const laser = profile.machineType === 'laser';
  const disp = (mm: number) => String(roundForDisplay(toDisplay(mm, 'length', units), 'length', units));
  const [s, setS] = useState({ x: '', y: '', z: '', origin: stock.origin as StockOrigin });
  const [assign, setAssign] = useState<Record<number, string>>({});
  const [def, setDef] = useState<string>(AUTO);
  const [res, setRes] = useState('0');
  const [libOpen, setLibOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setS({ x: disp(stock.size.x), y: disp(stock.size.y), z: disp(stock.size.z), origin: stock.origin });
      setAssign({ ...jobTools });
      setDef(defaultToolId ?? AUTO);
      setRes(String(resolution));
      setError(null);
    }
    // only when opened
  }, [open]);

  const field = (key: 'x' | 'y' | 'z', label: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`stock-${key}`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={`stock-${key}`} className="tabular text-right" inputMode="decimal" value={s[key]} onChange={(e) => setS({ ...s, [key]: e.target.value })} />
        <span className="w-8 text-xs text-muted-foreground">{u}</span>
      </div>
    </div>
  );

  const toolOptions = tools.map((t) => ({ value: t.id, label: `T${t.number} · ${t.name} (Ø${formatLength(t.diameter, units, units === 'inch' ? 3 : 2)})` }));
  const defId = def === AUTO ? null : def;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Stock &amp; tools</DialogTitle>
          <DialogDescription>Used by the material-removal simulation and the pre-flight checks (cuts below the stock, rapids through it, gouges, holder clearance).</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          {field('x', 'Width (X)')}
          {field('y', 'Depth (Y)')}
          {field('z', 'Thickness (Z)')}
        </div>
        <div className="flex flex-col gap-1">
          <Label>Where is your work zero (X0 Y0 Z0) on the stock?</Label>
          <Select aria-label="Work zero on the stock" value={s.origin} options={ORIGINS} onValueChange={(v) => setS({ ...s, origin: v as StockOrigin })} />
        </div>
        {!laser && (
          <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="tool-assignments">
            <div className="flex items-center justify-between">
              <Label>Tools</Label>
              <Button size="sm" variant="ghost" onClick={() => setLibOpen(true)} data-testid="open-tool-library">
                <Wrench /> Tool library…
              </Button>
            </div>
            {usedTools.map((ut) => (
              <div key={ut.tool} className="grid grid-cols-[110px_1fr] items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {ut.tool > 0 ? `Job T${ut.tool}` : 'No T number'} <span className="text-xs">(line {ut.firstLine})</span>
                </span>
                <Select
                  aria-label={`Tool for T${ut.tool}`}
                  value={assign[ut.tool] ?? resolveTool(ut.tool, tools, {}, defId)?.id ?? ''}
                  options={toolOptions}
                  onValueChange={(v) => setAssign({ ...assign, [ut.tool]: v })}
                />
              </div>
            ))}
            <div className="grid grid-cols-[110px_1fr] items-center gap-2 text-sm">
              <span className="text-muted-foreground">Default tool</span>
              <Select aria-label="Default tool" value={def} options={[{ value: AUTO, label: 'First tool in the library' }, ...toolOptions]} onValueChange={setDef} />
            </div>
            <p className="text-xs text-muted-foreground">A job's T number uses the library tool with the same number unless you pick another; moves without one use the default tool.</p>
          </div>
        )}
        <div className="grid grid-cols-[1fr_160px] items-center gap-3">
          <Label>Simulation resolution</Label>
          <Select
            aria-label="Simulation resolution"
            value={res}
            options={RESOLUTIONS.map((r) => ({ value: String(r), label: r === 0 ? 'Automatic' : `${formatLength(r, units, units === 'inch' ? 4 : 2)} ${u}` }))}
            onValueChange={setRes}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              useSim.setState({ stock: defaultStock(profile), jobTools: {}, defaultToolId: null });
              onOpenChange(false);
            }}
          >
            Reset to profile defaults
          </Button>
          <Button
            data-testid="stock-save"
            onClick={() => {
              const n = (v: string) => Number(v.replace(',', '.'));
              const vals = [s.x, s.y, s.z].map(n);
              if (vals.some((v) => !(v > 0) || !Number.isFinite(v))) {
                setError('Sizes must be positive numbers.');
                return;
              }
              const mm = (v: number) => fromDisplay(v, 'length', units);
              const next: StockSetup = { size: { x: mm(vals[0]!), y: mm(vals[1]!), z: mm(vals[2]!) }, origin: s.origin, color: stock.color };
              // keep only assignments that differ from the automatic choice
              const explicit = Object.fromEntries(Object.entries(assign).filter(([t, id]) => resolveTool(Number(t), tools, {}, defId)?.id !== id));
              useSim.setState({ stock: next, jobTools: explicit, defaultToolId: defId });
              if (Number(res) !== resolution) update((st) => ({ ...st, simResolution: Number(res) }));
              onOpenChange(false);
            }}
          >
            Apply
          </Button>
        </DialogFooter>
        <ToolLibraryDialog open={libOpen} onOpenChange={setLibOpen} units={units} />
      </DialogContent>
    </Dialog>
  );
}
