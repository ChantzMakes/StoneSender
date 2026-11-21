/**
 * Built-in generators: surfacing, pockets, drilling patterns and an outline
 * trace of the loaded job. The result is loaded as a normal job, so it is
 * analysed, shown in 3D and goes through pre-flight before anything moves.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { type DrillSpec, drilling, outlineTrace, pocket, type PocketSpec, surfacing, type SurfacingSpec, type GeneratedJob } from '@/lib/gcode/generators';
import type { MachineProfile } from '@/lib/profile/schema';
import { defaultStock, stockBox } from '@/lib/sim/setup';
import { errorMessage } from '@/lib/utils';
import { useAnalysis } from '@/store/analysis';
import { useLink } from '@/store/link';
import { useSim } from '@/store/sim';
import { useSimTool } from '../viewer/useSimSetup';
import { Fields, type NumField, readFields, toField } from './NumberFields';

type Tab = 'surfacing' | 'pocket' | 'drilling' | 'outline';

const COMMON: NumField[] = [
  { key: 'toolDiameter', label: 'Tool diameter', kind: 'length' },
  { key: 'feed', label: 'Feed', kind: 'feed' },
  { key: 'plungeFeed', label: 'Plunge feed', kind: 'feed' },
  { key: 'rpm', label: 'Spindle speed', kind: 'plain', unit: 'rpm' },
  { key: 'clearance', label: 'Clearance (above Z0)', kind: 'length' },
  { key: 'spinUp', label: 'Spin-up wait', kind: 'plain', unit: 's' },
];
const SURFACING: NumField[] = [
  { key: 'x0', label: 'From X', kind: 'length' },
  { key: 'y0', label: 'From Y', kind: 'length' },
  { key: 'x1', label: 'To X', kind: 'length' },
  { key: 'y1', label: 'To Y', kind: 'length' },
  { key: 'stepoverPct', label: 'Stepover', kind: 'plain', unit: '%' },
  { key: 'depthPerPass', label: 'Depth per pass', kind: 'length' },
  { key: 'totalDepth', label: 'Total depth', kind: 'length' },
];
const POCKET_RECT: NumField[] = [
  { key: 'cx', label: 'Centre X', kind: 'length' },
  { key: 'cy', label: 'Centre Y', kind: 'length' },
  { key: 'width', label: 'Width (X)', kind: 'length' },
  { key: 'height', label: 'Length (Y)', kind: 'length' },
];
const POCKET_CIRCLE: NumField[] = [
  { key: 'cx', label: 'Centre X', kind: 'length' },
  { key: 'cy', label: 'Centre Y', kind: 'length' },
  { key: 'diameter', label: 'Diameter', kind: 'length' },
];
const POCKET_DEPTH: NumField[] = [
  { key: 'depth', label: 'Depth', kind: 'length' },
  { key: 'stepdown', label: 'Depth per pass', kind: 'length' },
  { key: 'stepoverPct', label: 'Stepover', kind: 'plain', unit: '%' },
];
const DRILL_GRID: NumField[] = [
  { key: 'x0', label: 'First hole X', kind: 'length' },
  { key: 'y0', label: 'First hole Y', kind: 'length' },
  { key: 'nx', label: 'Holes in X', kind: 'plain' },
  { key: 'ny', label: 'Holes in Y', kind: 'plain' },
  { key: 'dx', label: 'Spacing X', kind: 'length' },
  { key: 'dy', label: 'Spacing Y', kind: 'length' },
];
const DRILL_CIRCLE: NumField[] = [
  { key: 'cx', label: 'Centre X', kind: 'length' },
  { key: 'cy', label: 'Centre Y', kind: 'length' },
  { key: 'radius', label: 'Circle radius', kind: 'length' },
  { key: 'count', label: 'Holes', kind: 'plain' },
  { key: 'startAngle', label: 'First hole angle', kind: 'plain', unit: '°' },
];
const DRILL_DEPTH: NumField[] = [
  { key: 'depth', label: 'Depth', kind: 'length' },
  { key: 'peck', label: 'Peck (0 = none)', kind: 'length' },
];
const OUTLINE: NumField[] = [
  { key: 'height', label: 'Trace height (above Z0)', kind: 'length' },
  { key: 'feed', label: 'Feed', kind: 'feed' },
];

export function GenerateDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: MachineProfile }) {
  const units = profile.units;
  const tool = useSimTool(profile);
  const stock = useSim((s) => s.stock) ?? defaultStock(profile);
  const analysis = useAnalysis((s) => s.result);
  const loaded = useLink((s) => s.loadedJob);
  const [tab, setTab] = useState<Tab>('surfacing');
  const [dir, setDir] = useState<'x' | 'y'>('x');
  const [shape, setShape] = useState<'rect' | 'circle'>('rect');
  const [pattern, setPattern] = useState<'grid' | 'circle'>('grid');
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const box = stockBox(stock);
    const mm: Record<string, number> = {
      toolDiameter: tool.diameter,
      feed: Math.min(1500, profile.motion.maxRate.x),
      plungeFeed: Math.min(300, profile.motion.maxRate.z),
      rpm: Math.round(profile.spindle.maxRpm * 0.75),
      clearance: Math.max(profile.safety.clearanceZ, 2),
      spinUp: profile.spindle.spinUpDelaySec,
      x0: box.min[0],
      y0: box.min[1],
      x1: box.max[0],
      y1: box.max[1],
      stepoverPct: 40,
      depthPerPass: 0.5,
      totalDepth: 0.5,
      cx: (box.min[0] + box.max[0]) / 2,
      cy: (box.min[1] + box.max[1]) / 2,
      width: 40,
      height: 30,
      diameter: 30,
      depth: 3,
      stepdown: 1,
      nx: 4,
      ny: 3,
      dx: 20,
      dy: 20,
      radius: 25,
      count: 6,
      startAngle: 0,
      peck: 2,
    };
    const all = [...COMMON, ...SURFACING, ...POCKET_RECT, ...POCKET_CIRCLE, ...POCKET_DEPTH, ...DRILL_GRID, ...DRILL_CIRCLE, ...DRILL_DEPTH];
    const next: Record<string, string> = {};
    for (const f of all) next[f.key] = toField(mm[f.key] ?? 0, f.kind, units);
    next.height = toField(Math.max(profile.safety.clearanceZ, 5), 'length', units);
    setV(next);
    setError(null);
  }, [open]);

  const fieldsFor = (t: Tab): NumField[] =>
    t === 'surfacing'
      ? [...SURFACING, ...COMMON]
      : t === 'pocket'
        ? [...(shape === 'rect' ? POCKET_RECT : POCKET_CIRCLE), ...POCKET_DEPTH, ...COMMON]
        : t === 'drilling'
          ? [...(pattern === 'grid' ? DRILL_GRID : DRILL_CIRCLE), ...DRILL_DEPTH, ...COMMON.filter((f) => f.key !== 'feed')]
          : OUTLINE;

  const create = async () => {
    const r = readFields(fieldsFor(tab), v, units);
    if (!r.ok) {
      setError(`“${r.bad}” must be a number.`);
      return;
    }
    const n = r.v;
    let g: GeneratedJob;
    if (tab === 'surfacing') g = surfacing({ ...(n as unknown as SurfacingSpec), direction: dir });
    else if (tab === 'pocket') g = pocket({ ...({ width: 0, height: 0, diameter: 0 } as Partial<PocketSpec>), ...(n as unknown as PocketSpec), shape });
    else if (tab === 'drilling') g = drilling({ ...({ x0: 0, y0: 0, nx: 0, ny: 0, dx: 0, dy: 0, cx: 0, cy: 0, radius: 0, count: 0, startAngle: 0 } as Partial<DrillSpec>), ...(n as unknown as DrillSpec), pattern });
    else {
      const b = analysis?.stats.cutBounds;
      if (!b || b.empty || !loaded) {
        setError('Open a job first: the outline traces its cutting area.');
        return;
      }
      g = outlineTrace(b, n.height!, n.feed!, loaded.name.replace(/\.[^.]+$/, ''));
    }
    if (g.errors.length) {
      setError(g.errors.join(' '));
      return;
    }
    try {
      await useLink.getState().loadJobText(g.name, g.text);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const fields = (list: NumField[], id: string) => <Fields fields={list} values={v} onChange={setV} units={units} idPrefix={`gen-${id}`} />;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate a job</DialogTitle>
          <DialogDescription>Simple jobs without CAM. Positions are in work coordinates (from your X0 Y0 Z0). The result opens as a normal job: check it in the 3D view, then run it with the usual pre-flight.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(t) => setTab(t as Tab)}>
          <TabsList>
            <TabsTrigger value="surfacing">Surfacing</TabsTrigger>
            <TabsTrigger value="pocket">Pocket</TabsTrigger>
            <TabsTrigger value="drilling">Drilling</TabsTrigger>
            <TabsTrigger value="outline">Outline trace</TabsTrigger>
          </TabsList>
          <TabsContent value="surfacing" className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Flattens the top of the stock (or a spoilboard) in zig-zag passes. The tool centre covers the area, so the cut reaches half a tool beyond it.</p>
            <div className="w-56">
              <Label>Passes run along</Label>
              <Select aria-label="Pass direction" value={dir} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }]} onValueChange={(d) => setDir(d as 'x')} />
            </div>
            {fields(SURFACING, 's')}
            {fields(COMMON, 'sc')}
          </TabsContent>
          <TabsContent value="pocket" className="flex flex-col gap-3">
            <div className="w-56">
              <Label>Shape</Label>
              <Select aria-label="Pocket shape" value={shape} options={[{ value: 'rect', label: 'Rectangle' }, { value: 'circle', label: 'Circle' }]} onValueChange={(s) => setShape(s as 'rect')} />
            </div>
            {fields(shape === 'rect' ? POCKET_RECT : POCKET_CIRCLE, 'p')}
            {fields(POCKET_DEPTH, 'pd')}
            {fields(COMMON, 'pc')}
            <p className="text-xs text-muted-foreground">Plunges straight down in the middle of the pocket — use a centre-cutting end mill.</p>
          </TabsContent>
          <TabsContent value="drilling" className="flex flex-col gap-3">
            <div className="w-56">
              <Label>Pattern</Label>
              <Select aria-label="Hole pattern" value={pattern} options={[{ value: 'grid', label: 'Grid' }, { value: 'circle', label: 'Bolt circle' }]} onValueChange={(p) => setPattern(p as 'grid')} />
            </div>
            {fields(pattern === 'grid' ? DRILL_GRID : DRILL_CIRCLE, 'd')}
            {fields(DRILL_DEPTH, 'dd')}
            {fields(COMMON.filter((f) => f.key !== 'feed'), 'dc')}
          </TabsContent>
          <TabsContent value="outline" className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Moves around the cutting area of the loaded job at a safe height with the spindle off, so you can see it fits on the stock and misses the clamps.</p>
            {fields(OUTLINE, 'o')}
          </TabsContent>
        </Tabs>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void create()} data-testid="generate-create">
            Create job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
