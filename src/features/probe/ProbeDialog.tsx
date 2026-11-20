/**
 * Probing wizards (spec §5): Z plate, XYZ corner, centre finding, tool
 * setter and surface height map. Each shows what will happen (diagram),
 * requires the probe connection test, runs step by step (every line waits
 * for the controller) and can be stopped with STOP or the Stop button here.
 */
import { Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { levelGcode } from '@/lib/gcode/level';
import { liveIO } from '@/lib/machine/liveIO';
import { applyToolLengthChange, measureOnToolSetter, probeCenter, probeCorner, probeHeightMap, probeSettings, probeZPlate, type MachineIO } from '@/lib/machine/routines';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { errorMessage } from '@/lib/utils';
import { useAnalysis } from '@/store/analysis';
import { sysMessage } from '@/store/console';
import { useLink } from '@/store/link';
import { useProbe } from '@/store/probe';
import { useSimTool } from '../viewer/useSimSetup';
import { ProbeDiagram } from './ProbeDiagram';
import { TouchTest, useTouchTest } from './TouchTest';

type Tab = 'z' | 'corner' | 'center' | 'setter' | 'heightmap';

export function ProbeDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: MachineProfile }) {
  const idle = useLink((s) => s.state === 'connected' && s.status?.state?.name === 'idle');
  const units = profile.units;
  const u = unitLabel('length', units);
  const disp = (mm: number) => String(roundForDisplay(toDisplay(mm, 'length', units), 'length', units));
  const toMm = (v: string) => fromDisplay(Number(v.replace(',', '.')), 'length', units);
  const tool = useSimTool(profile);
  const analysis = useAnalysis((s) => s.result);
  const jobText = useLink((s) => s.jobText);
  const loaded = useLink((s) => s.loadedJob);
  const setterRef = useProbe((s) => s.setterRef);
  const heightMap = useProbe((s) => s.heightMap);

  const [tab, setTab] = useState<Tab>(profile.probe.plateType === 'xyz' ? 'corner' : 'z');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [centerMode, setCenterMode] = useState<'inside' | 'outside'>('inside');
  const abort = useRef<AbortController | null>(null);
  const touch = useTouchTest(open);

  useEffect(() => {
    if (!open) return;
    const b = analysis?.stats.cutBounds;
    const has = b && !b.empty;
    setF({
      thick: disp(profile.probe.plateThickness),
      dia: disp(tool.diameter),
      clearance: disp(20),
      size: disp(20),
      depth: disp(5),
      hx0: disp(has ? b.min[0] : 0),
      hy0: disp(has ? b.min[1] : 0),
      hx1: disp(has ? b.max[0] : 100),
      hy1: disp(has ? b.max[1] : 100),
      hnx: has ? String(Math.min(20, Math.max(2, Math.ceil((b.max[0] - b.min[0]) / 15) + 1))) : '5',
      hny: has ? String(Math.min(20, Math.max(2, Math.ceil((b.max[1] - b.min[1]) / 15) + 1))) : '5',
      hclear: disp(3),
      hdepth: disp(3),
    });
    setResult(null);
    setError(null);
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  const s = probeSettings(profile);
  const field = (key: string, label: string, unit = u) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`pr-${key}`}>{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input id={`pr-${key}`} className="tabular text-right" inputMode="decimal" value={f[key] ?? ''} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
        {unit && <span className="w-7 text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );

  const run = async (label: string, body: (io: MachineIO) => Promise<string>) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setError(null);
    setResult(null);
    setStep(label);
    try {
      const msg = await body(liveIO(ac.signal, setStep));
      setResult(msg);
      sysMessage(msg);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setStep(null);
      touch.reset();
    }
  };

  const fmt = (mm: number) => `${formatLength(mm, units, 3)} ${u}`;
  // Every probing move needs the connection test first (owner decision).
  const ready = idle && !busy && touch.passed;
  const runBtn = (label: string, onClick: () => void, testId: string) => (
    <Button disabled={!ready} onClick={onClick} data-testid={testId}>
      {label}
    </Button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) abort.current?.abort();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Probe</DialogTitle>
          <DialogDescription>Find zero, the centre of a hole, a bit's length or the shape of the surface with a touch plate or probe. Keep a hand near STOP the first time.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="z">Z plate</TabsTrigger>
            <TabsTrigger value="corner">XYZ corner</TabsTrigger>
            <TabsTrigger value="center">Centre</TabsTrigger>
            <TabsTrigger value="setter">Tool setter</TabsTrigger>
            <TabsTrigger value="heightmap">Surface map</TabsTrigger>
          </TabsList>

          <TabsContent value="z" className="flex flex-col gap-3">
            <ProbeDiagram kind="z" />
            <p className="text-sm">Lay the plate on the stock under the bit, clip the lead to the bit, and jog to a few mm above the plate.</p>
            <div className="grid grid-cols-3 gap-3">{field('thick', 'Plate thickness')}</div>
            <TouchTest test={touch} />
            {runBtn('Probe Z', () => void run('Probing Z…', async (io) => {
              const r = await probeZPlate(io, s, toMm(f.thick!));
              return `Z zero set on the stock (plate touched at machine Z ${fmt(r.touchZ)}).`;
            }), 'probe-z')}
          </TabsContent>

          <TabsContent value="corner" className="flex flex-col gap-3">
            <ProbeDiagram kind="corner" />
            <p className="text-sm">Put the corner plate on the front-left corner of the stock. Jog the bit over the plate's flat top, within about 10 mm of its corner and a few mm above it.</p>
            <div className="grid grid-cols-3 gap-3">
              {field('thick', 'Plate thickness')}
              {field('dia', 'Bit diameter')}
              {field('clearance', 'Move off the plate')}
            </div>
            <p className="text-xs text-muted-foreground">
              Plate side offsets from the profile: X {fmt(profile.probe.xyOffset.x)}, Y {fmt(profile.probe.xyOffset.y)}.
            </p>
            <TouchTest test={touch} />
            {runBtn('Probe X, Y and Z', () => void run('Probing the corner…', async (io) => {
              await probeCorner(io, s, { plateThickness: toMm(f.thick!), xyOffset: profile.probe.xyOffset, toolDiameter: toMm(f.dia!), clearance: toMm(f.clearance!) });
              return 'X0 Y0 set at the stock corner and Z0 on its top.';
            }), 'probe-corner')}
          </TabsContent>

          <TabsContent value="center" className="flex flex-col gap-3">
            <ProbeDiagram kind={centerMode === 'inside' ? 'center-inside' : 'center-outside'} />
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <Label>Find the centre of</Label>
                <Select aria-label="Centre mode" value={centerMode} options={[{ value: 'inside', label: 'A hole (inside)' }, { value: 'outside', label: 'A boss (outside)' }]} onValueChange={(v) => setCenterMode(v as 'inside')} />
              </div>
              {field('size', 'Approx. width')}
              {field('dia', 'Probe / bit diameter')}
              {centerMode === 'outside' && field('depth', 'Drop beside it by')}
            </div>
            <p className="text-sm">{centerMode === 'inside' ? 'Lower the probe into the hole, below the rim, roughly in the middle.' : 'Jog above the middle of the boss, a few mm above its top.'}</p>
            <TouchTest test={touch} />
            {runBtn('Find centre', () => void run('Finding the centre…', async (io) => {
              const r = await probeCenter(io, s, { mode: centerMode, size: toMm(f.size!), depth: toMm(f.depth!), toolDiameter: toMm(f.dia!) });
              return `X0 Y0 set at the centre. Measured ${fmt(r.width[0])} × ${fmt(r.width[1])}.`;
            }), 'probe-center')}
          </TabsContent>

          <TabsContent value="setter" className="flex flex-col gap-3">
            <ProbeDiagram kind="setter" />
            {!profile.probe.toolSetter.enabled ? (
              <p className="text-sm text-muted-foreground">No tool setter in this profile. Add its position under Machine profile → Probe & touch plate.</p>
            ) : (
              <>
                <p className="text-sm">
                  Before changing a bit by hand, measure the current one. After the change, measure the new one: work Z moves by the length difference so Z0 stays on the same surface.
                  {setterRef && ` A bit was measured ${Math.round((Date.now() - setterRef.at) / 60000)} min ago.`}
                </p>
                <TouchTest test={touch} what="the tool setter button" />
                <div className="flex gap-2">
                  {runBtn('Measure the current bit', () => void run('Measuring…', async (io) => {
                    const m = await measureOnToolSetter(io, s, profile);
                    useProbe.setState({ setterRef: { workZ: m.workZ, at: Date.now() } });
                    return `Bit measured (touch at work Z ${fmt(m.workZ)}). Change the bit, then measure the new one.`;
                  }), 'setter-ref')}
                  <Button
                    variant="secondary"
                    disabled={!ready || !setterRef}
                    data-testid="setter-apply"
                    onClick={() =>
                      void run('Measuring the new bit…', async (io) => {
                        const ref = useProbe.getState().setterRef!;
                        const m = await measureOnToolSetter(io, s, profile);
                        await applyToolLengthChange(io, m.machineZ, ref.workZ, profile);
                        return `New bit measured: Z0 moved by ${fmt(m.workZ - ref.workZ)}.`;
                      })
                    }
                  >
                    Measure the new bit and keep Z0
                  </Button>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="heightmap" className="flex flex-col gap-3">
            <ProbeDiagram kind="heightmap" />
            <p className="text-sm">For engraving uneven stock or PCBs. Set Z0 on the surface first; clip the lead to the bit (the surface must conduct, or use a probe). The job is then bent to follow the measured surface.</p>
            <div className="grid grid-cols-4 gap-3">
              {field('hx0', 'From X')}
              {field('hy0', 'From Y')}
              {field('hx1', 'To X')}
              {field('hy1', 'To Y')}
              {field('hnx', 'Points in X', '')}
              {field('hny', 'Points in Y', '')}
              {field('hclear', 'Travel height')}
              {field('hdepth', 'Search below Z0')}
            </div>
            <TouchTest test={touch} />
            <div className="flex flex-wrap gap-2">
              {runBtn('Probe the surface', () => void run('Probing the surface…', async (io) => {
                const nx = Math.max(2, Math.min(50, Math.round(Number(f.hnx))));
                const ny = Math.max(2, Math.min(50, Math.round(Number(f.hny))));
                const h = await probeHeightMap(io, s, { x0: toMm(f.hx0!), y0: toMm(f.hy0!), x1: toMm(f.hx1!), y1: toMm(f.hy1!), nx, ny, clearance: toMm(f.hclear!), depth: toMm(f.hdepth!) });
                useProbe.setState({ heightMap: { ...h, at: Date.now() } });
                const lo = Math.min(...h.z);
                const hi = Math.max(...h.z);
                return `Surface measured at ${nx * ny} points: ${fmt(lo)} to ${fmt(hi)} (spread ${fmt(hi - lo)}).`;
              }), 'probe-heightmap')}
              <Button
                variant="secondary"
                disabled={!heightMap || !jobText || !loaded || busy}
                data-testid="apply-leveling"
                onClick={() => {
                  if (!heightMap || !jobText || !loaded) return;
                  const r = levelGcode(jobText, heightMap);
                  if (r.errors.length) {
                    setError(`Can't level this job: ${r.errors.slice(0, 3).join(' ')}`);
                    return;
                  }
                  const name = loaded.name.replace(/(\.[^.]+)?$/, (ext) => `-leveled${ext || '.nc'}`);
                  useLink
                    .getState()
                    .loadJobText(name, r.text)
                    .then(() => setResult(`Loaded ${name}: ${r.changed} moves follow the surface (largest correction ${fmt(r.maxCorrection)}). Check it in the 3D view before running.`))
                    .catch((e: unknown) => setError(errorMessage(e)));
                }}
              >
                Apply to the loaded job
              </Button>
            </div>
            {heightMap && <HeightMapPreview z={heightMap.z} nx={heightMap.nx} ny={heightMap.ny} />}
          </TabsContent>
        </Tabs>
        {step && <p className="text-xs text-muted-foreground">{step}</p>}
        {result && (
          <p className="text-sm text-success" data-testid="probe-result">
            {result}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="probe-error">
            {error}
          </p>
        )}
        {busy && (
          <Button variant="destructive" size="sm" className="self-start" onClick={() => void useLink.getState().sendRealtime(0x18)}>
            <Square /> Stop probing (reset)
          </Button>
        )}
        {!idle && !busy && <p className="text-xs text-muted-foreground">Connect and wait until the machine is Idle to probe.</p>}
      </DialogContent>
    </Dialog>
  );
}

/** Colour grid of the measured surface (low = blue, high = red). */
function HeightMapPreview({ z, nx, ny }: { z: number[]; nx: number; ny: number }) {
  const lo = Math.min(...z);
  const hi = Math.max(...z);
  const span = hi - lo || 1;
  return (
    <div className="grid gap-px self-start overflow-hidden rounded border" style={{ gridTemplateColumns: `repeat(${nx}, 14px)` }} data-testid="heightmap-preview">
      {Array.from({ length: ny }, (_, r) => ny - 1 - r).flatMap((j) =>
        Array.from({ length: nx }, (_, i) => {
          const t = (z[j * nx + i]! - lo) / span;
          return <div key={`${i}-${j}`} title={z[j * nx + i]!.toFixed(3)} style={{ width: 14, height: 14, background: `hsl(${240 - 240 * t} 70% 50%)` }} />;
        }),
      )}
    </div>
  );
}
