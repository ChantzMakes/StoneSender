/** Stock and tool settings for the simulator and the pre-flight collision checks. */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/primitives';
import type { MachineProfile } from '@/lib/profile/schema';
import { fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { defaultStock, defaultTool, type StockOrigin, type StockSetup, type ToolSetup } from '@/lib/sim/setup';
import { useSim } from '@/store/sim';

const ORIGINS: { value: StockOrigin; label: string }[] = [
  { value: 'front-left-top', label: 'Front-left corner, top surface (most common)' },
  { value: 'center-top', label: 'Centre, top surface' },
  { value: 'front-left-bottom', label: 'Front-left corner, bottom (spoilboard)' },
];

export function StockDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: MachineProfile }) {
  const stock = useSim((s) => s.stock) ?? defaultStock(profile);
  const tool = useSim((s) => s.tool) ?? defaultTool(profile);
  const units = profile.units;
  const u = unitLabel('length', units);
  const disp = (mm: number) => String(roundForDisplay(toDisplay(mm, 'length', units), 'length', units));
  const [s, setS] = useState({ x: '', y: '', z: '', origin: stock.origin as StockOrigin, dia: '', stick: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setS({ x: disp(stock.size.x), y: disp(stock.size.y), z: disp(stock.size.z), origin: stock.origin, dia: disp(tool.diameter), stick: disp(tool.stickout) });
      setError(null);
    }
    // only when opened
  }, [open]);

  const field = (key: 'x' | 'y' | 'z' | 'dia' | 'stick', label: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`stock-${key}`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={`stock-${key}`} className="tabular text-right" inputMode="decimal" value={s[key]} onChange={(e) => setS({ ...s, [key]: e.target.value })} />
        <span className="w-8 text-xs text-muted-foreground">{u}</span>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Stock &amp; tool</DialogTitle>
          <DialogDescription>Used by the 3D view and the pre-flight checks (cuts below the stock, rapids through it). The material-removal simulation arrives in the next update.</DialogDescription>
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
        {profile.machineType !== 'laser' && (
          <div className="grid grid-cols-2 gap-3">
            {field('dia', 'Bit diameter')}
            {field('stick', 'Bit stick-out')}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              useSim.setState({ stock: defaultStock(profile), tool: defaultTool(profile) });
              onOpenChange(false);
            }}
          >
            Reset to profile defaults
          </Button>
          <Button
            data-testid="stock-save"
            onClick={() => {
              const n = (v: string) => Number(v.replace(',', '.'));
              const vals = [s.x, s.y, s.z, s.dia, s.stick].map(n);
              if (vals.slice(0, 3).some((v) => !(v > 0)) || (profile.machineType !== 'laser' && !(vals[3]! > 0)) || vals[4]! < 0 || vals.some((v) => !Number.isFinite(v))) {
                setError('Sizes must be positive numbers.');
                return;
              }
              const mm = (v: number) => fromDisplay(v, 'length', units);
              const next: StockSetup = { size: { x: mm(vals[0]!), y: mm(vals[1]!), z: mm(vals[2]!) }, origin: s.origin, color: stock.color };
              const nextTool: ToolSetup = profile.machineType === 'laser' ? tool : { diameter: mm(vals[3]!), stickout: mm(vals[4]!) };
              useSim.setState({ stock: next, tool: nextTool });
              onOpenChange(false);
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
