/** 3D toolpath viewer: canvas, toolbar, legend and playback scrubber. */
import { Canvas } from '@react-three/fiber';
import { Box, Cog, Maximize, Crosshair, Eye, EyeOff, Grid3x3, LocateFixed, Package, Pause, Play, Ruler, Settings2, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, Tip } from '@/components/ui/primitives';
import { sampleAt } from '@/lib/gcode/render';
import { machineBounds } from '@/lib/profile/geometry';
import { runChecks } from '@/lib/sim/checks';
import { stockBox } from '@/lib/sim/setup';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, toDisplay, unitLabel } from '@/lib/profile/units';
import { useAnalysis } from '@/store/analysis';
import { useApp } from '@/store/app';
import { isActivePhase, useLink } from '@/store/link';
import { type ColorMode, SPEEDS, useSim } from '@/store/sim';
import { formatDuration } from '../job/format';
import { machineLayout } from './MachineModel';
import { Scene, type Palette, type ViewBounds } from './Scene';
import { StockDialog } from './StockDialog';
import { useSimSetup, useSimWco } from './useSimSetup';

const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { background: '#141920', grid: '#2a3340', section: '#3c4a5c', label: '#9aa7b6' },
  light: { background: '#f3f5f8', grid: '#d5dbe3', section: '#b3bcc8', label: '#4b5563' },
};

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function Legend({ profile }: { profile: MachineProfile }) {
  const mode = useSim((s) => s.colorMode);
  const result = useAnalysis((s) => s.result);
  const units = profile.units;
  if (mode === 'type') {
    const items: [string, string][] = [
      ['#ff9e42', profile.machineType === 'laser' ? 'Travel' : 'Rapid'],
      ['#4fa1ff', profile.machineType === 'laser' ? 'Burn' : 'Cut'],
      ['#59d68c', 'Arc'],
      ...(profile.machineType === 'laser' ? [] : ([['#ff5c7a', 'Plunge']] as [string, string][])),
      ['#c48cff', 'Probe'],
      ['#73777f', 'Done'],
    ];
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {items.map(([c, l]) => (
          <span key={l} className="flex items-center gap-1">
            <span className="h-0.5 w-3" style={{ background: c }} />
            {l}
          </span>
        ))}
      </div>
    );
  }
  const s = result?.stats;
  const range: [string, string] =
    mode === 'feed'
      ? [`${Math.round(toDisplay(s?.feedRange?.[0] ?? 0, 'feed', units))}`, `${Math.round(toDisplay(s?.feedRange?.[1] ?? 0, 'feed', units))} ${unitLabel('feed', units)}`]
      : mode === 'z'
        ? [formatLength((s?.cutBounds.empty ? s?.workBounds : s?.cutBounds)?.min[2] ?? 0, units, 2), `${formatLength((s?.cutBounds.empty ? s?.workBounds : s?.cutBounds)?.max[2] ?? 0, units, 2)} ${unitLabel('length', units)}`]
        : ['0', `S${profile.machineType === 'laser' ? profile.laser.maxPower : (s?.spindleRange?.[1] ?? 0)}`];
  return (
    <div className="flex items-center gap-2">
      <span className="tabular">{range[0]}</span>
      <span className="h-1.5 w-24 rounded" style={{ background: 'linear-gradient(90deg,#2c61ff,#26d98c,#ffd133,#ff4545)' }} />
      <span className="tabular">{range[1]}</span>
    </div>
  );
}

function Scrubber() {
  const result = useAnalysis((s) => s.result);
  const job = useLink((s) => s.job);
  const { time, playing, speed, line } = useSim();
  const setTime = useSim((s) => s.setTime);
  const set = useSim((s) => s.set);
  const live = isActivePhase(job?.phase) && job?.mode === 'run';
  const total = result?.stats.time.total ?? 0;
  const liveTime = live && result ? (result.lineEndTime[Math.min(job!.currentLine, result.lineEndTime.length - 1)] ?? 0) : null;
  const shown = liveTime ?? time;
  const disabled = !result || live || total <= 0;

  const seek = (t: number) => {
    setTime(t);
    if (result) set({ line: sampleAt(result.toolpath, result.render.segEnd, t).line });
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-t px-2 text-xs" data-testid="scrubber">
      <Tip content="Back to the start">
        <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => { set({ playing: false }); seek(0); }} aria-label="Back to start">
          <SkipBack />
        </Button>
      </Tip>
      <Button
        variant="secondary"
        size="icon-sm"
        disabled={disabled}
        data-testid="play-button"
        aria-label={playing ? 'Pause playback' : 'Play'}
        onClick={() => {
          if (!playing && time >= total) seek(0);
          set({ playing: !playing });
        }}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <Tip content="Jump to the end">
        <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => { set({ playing: false }); seek(total); }} aria-label="Jump to end">
          <SkipForward />
        </Button>
      </Tip>
      <input
        type="range"
        className="min-w-0 flex-1 accent-[var(--color-primary)]"
        min={0}
        max={Math.max(total, 0.001)}
        step={Math.max(total / 2000, 0.001)}
        value={Math.min(shown, total)}
        disabled={disabled}
        aria-label="Playback position"
        data-testid="scrub-slider"
        onChange={(e) => {
          set({ playing: false });
          seek(Number(e.target.value));
        }}
      />
      <span className="tabular w-28 text-right text-muted-foreground" data-testid="scrub-time">
        {formatDuration(shown * 1000)} / {formatDuration(total * 1000)}
      </span>
      <span className="tabular w-16 text-muted-foreground">{live ? `L${job!.currentLine}` : line ? `L${line}` : ''}</span>
      <div className="w-20">
        <Select
          aria-label="Playback speed"
          value={String(speed)}
          disabled={disabled}
          options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
          onValueChange={(v) => set({ speed: Number(v) })}
        />
      </div>
      {live && <span className="text-info">live job</span>}
    </div>
  );
}

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'type', label: 'Colour: move type' },
  { value: 'feed', label: 'Colour: feed rate' },
  { value: 'z', label: 'Colour: depth (Z)' },
  { value: 'power', label: 'Colour: spindle / laser power' },
];

const seen: { profile?: string; analysis?: unknown } = {};

export function Viewer3D({ profile }: { profile: MachineProfile }) {
  const analysis = useAnalysis((s) => s.result);
  const status = useAnalysis((s) => s.status);
  const theme = useApp((s) => s.settings.theme);
  const connected = useLink((s) => s.state === 'connected');
  const sim = useSim();
  const [stockOpen, setStockOpen] = useState(false);
  const { stock, tool } = useSimSetup(profile);
  const { wco: simWco, assumed } = useSimWco(profile, stock);
  const wcoKey = simWco.map((v) => v.toFixed(3)).join(',');
  // Recompute only when the placement actually changes, not on every status report.
  const layout = useMemo(() => machineLayout(profile, simWco, tool), [profile, wcoKey, tool]);
  const checks = useMemo(() => {
    if (!analysis) return null;
    const b = machineBounds(profile);
    return runChecks({
      tp: analysis.toolpath,
      wco: simWco,
      bounds: { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] },
      stock: profile.machineType === 'rotary' ? null : stockBox(stock),
      toolRadius: tool.diameter / 2,
      laser: profile.machineType === 'laser',
    });
  }, [analysis, profile, wcoKey, stock, tool]);
  const palette = PALETTES[theme];
  const units = profile.units;
  const env = profile.geometry.envelope;

  // The view unmounts when another tab is shown, so remember what we last
  // saw at module level: only a *different* profile / job resets state.
  useEffect(() => {
    const key = `${profile.id}:${profile.machineType}`;
    if (seen.profile !== key) {
      seen.profile = key;
      // Laser profiles default to colouring by power.
      useSim.setState({ colorMode: profile.machineType === 'laser' ? 'power' : 'type' });
    }
  }, [profile.id, profile.machineType]);

  useEffect(() => {
    if (seen.analysis !== analysis) {
      const first = seen.analysis === undefined;
      seen.analysis = analysis;
      // New job: rewind playback (but keep a position set before the view first mounted).
      if (!first) useSim.setState({ time: 0, playing: false, line: 0, measure: [] });
    }
  }, [analysis]);

  const bounds: ViewBounds = useMemo(() => {
    const b = analysis?.stats.workBounds;
    if (b && !b.empty) return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
    // No job: frame the whole machine.
    return { min: layout.frameMin, max: [layout.frameMax[0], layout.frameMax[1], layout.beamZ + 40] };
  }, [analysis, layout]);

  const hasGL = useMemo(webglAvailable, []);
  const btn = (label: string, onClick: () => void, icon: React.ReactNode, active = false, testId?: string) => (
    <Tip content={label}>
      <Button variant={active ? 'secondary' : 'ghost'} size="icon-sm" onClick={onClick} aria-label={label} aria-pressed={active} data-testid={testId}>
        {icon}
      </Button>
    </Tip>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="viewer">
      <div className="relative min-h-0 flex-1">
        {hasGL ? (
          <Canvas frameloop="demand" camera={{ fov: 40, position: [150, -200, 180], near: 0.1, far: 100000 }} gl={{ antialias: true }} dpr={[1, 2]} data-testid="viewer-canvas">
            <Scene analysis={analysis} profile={profile} palette={palette} bounds={bounds} layout={layout} stock={stock} tool={tool} wco={simWco} problems={checks?.problems ?? []} />
          </Canvas>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">3D view needs WebGL, which is not available here. Update your graphics drivers.</div>
        )}

        {/* toolbar */}
        <div className="absolute top-2 right-2 flex flex-wrap items-center justify-end gap-0.5 rounded-md border bg-card/85 p-0.5 backdrop-blur">
          {(['top', 'front', 'side', 'iso'] as const).map((v) => (
            <Button key={v} size="sm" variant="ghost" className="h-7 px-2 text-xs capitalize" onClick={() => sim.requestView(v)} data-testid={`view-${v}`}>
              {v === 'iso' ? '3D' : v}
            </Button>
          ))}
          <div className="mx-0.5 h-5 w-px bg-border" />
          {btn('Fit to job', () => sim.requestView('fit'), <Box />, false, 'view-fit')}
          {btn('Show the whole machine', () => sim.requestView('machine'), <Maximize />, false, 'view-machine')}
          {btn('Follow the tool', () => sim.set({ follow: !sim.follow }), <LocateFixed />, sim.follow, 'toggle-follow')}
          {btn(sim.showRapids ? 'Hide rapids' : 'Show rapids', () => sim.set({ showRapids: !sim.showRapids }), sim.showRapids ? <Eye /> : <EyeOff />, !sim.showRapids, 'toggle-rapids')}
          {btn('Grid and rulers', () => sim.set({ showGrid: !sim.showGrid }), <Grid3x3 />, sim.showGrid)}
          {btn('Machine travel box and home', () => sim.set({ showEnvelope: !sim.showEnvelope }), <Crosshair />, sim.showEnvelope)}
          {btn(sim.showMachine ? 'Hide machine' : 'Show machine', () => sim.set({ showMachine: !sim.showMachine }), <Cog />, sim.showMachine, 'toggle-machine')}
          {btn(sim.showStock ? 'Hide stock' : 'Show stock', () => sim.set({ showStock: !sim.showStock }), <Package />, sim.showStock)}
          {btn('Stock & tool settings', () => setStockOpen(true), <Settings2 />, false, 'stock-settings')}
          {btn(sim.measuring ? 'Stop measuring' : 'Measure: click two points', () => sim.set({ measuring: !sim.measuring, measure: [] }), <Ruler />, sim.measuring, 'toggle-measure')}
          <div className="w-52">
            <Select aria-label="Colour mode" value={sim.colorMode} options={COLOR_MODES} onValueChange={(v) => sim.set({ colorMode: v as ColorMode })} className="h-7 text-xs" />
          </div>
        </div>

        {/* info + legend */}
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col gap-1 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur" data-testid="viewer-info">
          <span>
            Machine travel {formatLength(env.x, units, 0)} × {formatLength(env.y, units, 0)} × {formatLength(env.z, units, 0)} {unitLabel('length', units)}
            {!connected && ' · connect to place it around your work zero'}
          </span>
          {analysis && (
            <span>
              {analysis.render.fullSegments.toLocaleString()} segments{analysis.render.decimated ? ` (simplified to ${(analysis.render.vertexCount / 2).toLocaleString()} for display)` : ''}
            </span>
          )}
          {assumed && <span>Machine placed assuming the stock lies on the bed (connect to use your real work zero)</span>}
          {sim.measuring && <span className="text-yellow-500">Click two points (snaps to toolpath ends)</span>}
          <Legend profile={profile} />
        </div>
        {checks && (checks.travel.length > 0 || checks.belowStock || checks.rapidsThroughStockCount > 0) && (
          <div className="pointer-events-none absolute top-12 right-2 flex max-w-xs flex-col gap-0.5 rounded-md border border-destructive/40 bg-card/90 px-2 py-1 text-[11px] backdrop-blur" data-testid="sim-problems">
            {checks.travel.length > 0 && <span className="text-red-500">● Leaves the machine travel ({checks.travel.map((t) => `${t.axis}${t.side === 'max' ? '+' : '−'}`).join(', ')}) from line {checks.travel[0]!.line}</span>}
            {checks.belowStock && (
              <span className="text-fuchsia-400">
                ● Cuts {formatLength(checks.belowStock.maxDepth, units, 2)} {unitLabel('length', units)} below the stock from line {checks.belowStock.line}
              </span>
            )}
            {checks.rapidsThroughStockCount > 0 && <span className="text-orange-400">● {checks.rapidsThroughStockCount} rapid move(s) through the stock, first at line {checks.rapidsThroughStock[0]!.line}</span>}
            {assumed && <span className="text-muted-foreground">Travel checked against an assumed work zero.</span>}
          </div>
        )}
        {!analysis && status !== 'running' && <div className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-muted-foreground">Open a G-code file to see its toolpath.</div>}
        {status === 'running' && <div className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-muted-foreground">Preparing the toolpath…</div>}
      </div>
      <Scrubber />
      <StockDialog open={stockOpen} onOpenChange={setStockOpen} profile={profile} />
    </div>
  );
}
