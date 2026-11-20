/**
 * 2D top view of the work envelope from the active profile, with the home
 * corner, work zero and live tool position. A placeholder until the 3D
 * viewer arrives in Phase 4 — but already driven entirely by the profile.
 */
import { PanelTitle } from '@/components/ui/primitives';
import { homePosition, machineBounds } from '@/lib/profile/geometry';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength } from '@/lib/profile/units';
import { useLink } from '@/store/link';

export function WorkAreaView({ profile }: { profile: MachineProfile }) {
  const status = useLink((s) => s.status);
  const b = machineBounds(profile);
  const home = homePosition(profile);
  const w = b.max.x - b.min.x;
  const h = b.max.y - b.min.y;
  const pad = Math.max(w, h) * 0.08;
  // SVG y grows downward; machine +Y is the back of the machine (top of the view).
  const toSvg = (x: number, y: number) => [x - b.min.x, b.max.y - y] as const;
  const tool = status?.mpos?.length ? toSvg(status.mpos[0]!, status.mpos[1]!) : null;
  const wco = status?.wco?.length ? toSvg(status.wco[0]!, status.wco[1]!) : null;
  const [hx, hy] = toSvg(home.x, home.y);
  const r = Math.max(w, h) * 0.012;
  const unit = profile.units === 'inch' ? 'in' : 'mm';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelTitle>
        Work area — {formatLength(w, profile.units, 0)} × {formatLength(h, profile.units, 0)} {unit}
      </PanelTitle>
      <div className="relative min-h-0 flex-1 p-4">
        <svg viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-label="Top view of the work area">
          <rect x={0} y={0} width={w} height={h} className="fill-muted/60 stroke-border" strokeWidth={r * 0.3} rx={r} />
          {Array.from({ length: 9 }, (_, i) => (
            <g key={i} className="stroke-border/60" strokeWidth={r * 0.12}>
              <line x1={((i + 1) * w) / 10} y1={0} x2={((i + 1) * w) / 10} y2={h} />
              <line x1={0} y1={((i + 1) * h) / 10} x2={w} y2={((i + 1) * h) / 10} />
            </g>
          ))}
          <text x={w / 2} y={-pad * 0.35} textAnchor="middle" className="fill-muted-foreground" fontSize={pad * 0.4}>
            back
          </text>
          <text x={w / 2} y={h + pad * 0.7} textAnchor="middle" className="fill-muted-foreground" fontSize={pad * 0.4}>
            front
          </text>
          <g>
            <circle cx={hx} cy={hy} r={r * 1.6} className="fill-none stroke-primary" strokeWidth={r * 0.35} />
            <text x={hx} y={hy + (hy < h / 2 ? r * 5 : -r * 3.2)} textAnchor={hx < w / 2 ? 'start' : 'end'} className="fill-primary" fontSize={pad * 0.38}>
              home
            </text>
          </g>
          {wco && (
            <g className="stroke-success" strokeWidth={r * 0.35}>
              <line x1={wco[0] - r * 2} y1={wco[1]} x2={wco[0] + r * 2} y2={wco[1]} />
              <line x1={wco[0]} y1={wco[1] - r * 2} x2={wco[0]} y2={wco[1] + r * 2} />
            </g>
          )}
          {tool && <circle cx={tool[0]} cy={tool[1]} r={r * 1.2} className="fill-destructive" data-testid="tool-marker" />}
        </svg>
        <div className="pointer-events-none absolute bottom-3 left-4 flex gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-destructive" /> tool
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 bg-success" /> work zero
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full border border-primary" /> home
          </span>
        </div>
        <div className="pointer-events-none absolute right-4 bottom-3 text-xs text-muted-foreground">3D view arrives in Phase 4</div>
      </div>
    </div>
  );
}
