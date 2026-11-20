/** SVG diagrams that explain profile fields. Colours come from theme tokens. */
import type { HomeCorner, MachineType } from '@/lib/profile/schema';
import { cn } from '@/lib/utils';

const corners: { id: HomeCorner; x: number; y: number; label: string }[] = [
  { id: 'back-left', x: 60, y: 40, label: 'Back left' },
  { id: 'back-right', x: 300, y: 40, label: 'Back right' },
  { id: 'front-left', x: 60, y: 200, label: 'Front left' },
  { id: 'front-right', x: 300, y: 200, label: 'Front right' },
];

/** Top-down view of the bed. Click a corner to choose where the machine homes. */
export function HomeCornerDiagram({ value, onChange, zDirection }: { value: HomeCorner; onChange?: (c: HomeCorner) => void; zDirection: 'up' | 'down' }) {
  return (
    <svg viewBox="0 0 360 290" className="w-full max-w-md" role="group" aria-label="Machine bed seen from above">
      <rect x="60" y="40" width="240" height="160" rx="6" className="fill-muted stroke-border" strokeWidth="2" />
      {/* grid */}
      {[1, 2, 3].map((i) => (
        <line key={`v${i}`} x1={60 + i * 60} y1="40" x2={60 + i * 60} y2="200" className="stroke-border" strokeDasharray="3 4" />
      ))}
      {[1].map((i) => (
        <line key={`h${i}`} x1="60" y1={40 + i * 80} x2="300" y2={40 + i * 80} className="stroke-border" strokeDasharray="3 4" />
      ))}
      <text x="180" y="24" textAnchor="middle" className="fill-muted-foreground text-[11px]">
        BACK of machine
      </text>
      <text x="180" y="232" textAnchor="middle" className="fill-foreground text-[12px] font-semibold">
        FRONT — you stand here
      </text>
      {/* person */}
      <g transform="translate(180 262)" className="fill-muted-foreground">
        <circle cx="0" cy="-10" r="6" />
        <rect x="-9" y="-2" width="18" height="16" rx="5" />
      </g>
      {/* axis arrows */}
      <g className="stroke-primary fill-primary" strokeWidth="2">
        <line x1="20" y1="250" x2="54" y2="250" />
        <path d="M54 245 L62 250 L54 255 Z" />
        <line x1="20" y1="250" x2="20" y2="216" />
        <path d="M15 216 L20 208 L25 216 Z" />
      </g>
      <text x="66" y="254" className="fill-primary text-[11px] font-semibold">
        +X
      </text>
      <text x="26" y="212" className="fill-primary text-[11px] font-semibold">
        +Y
      </text>
      {corners.map((c) => {
        const selected = c.id === value;
        return (
          <g
            key={c.id}
            role="button"
            tabIndex={onChange ? 0 : -1}
            aria-pressed={selected}
            aria-label={`Home is ${c.label}`}
            className={cn(onChange && 'cursor-pointer')}
            onClick={() => onChange?.(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onChange?.(c.id);
            }}
          >
            <circle cx={c.x} cy={c.y} r={selected ? 18 : 12} className={selected ? 'fill-primary' : 'fill-card stroke-muted-foreground'} strokeWidth="2" />
            {selected ? (
              <path d={`M${c.x - 8} ${c.y + 1} L${c.x} ${c.y - 8} L${c.x + 8} ${c.y + 1} M${c.x - 5} ${c.y - 1} V${c.y + 7} H${c.x + 5} V${c.y - 1}`} className="fill-none stroke-primary-foreground" strokeWidth="2" />
            ) : null}
            <text
              x={c.x + (c.x < 180 ? -4 : 4)}
              y={c.y + (c.y < 120 ? -24 : 34)}
              textAnchor={c.x < 180 ? 'start' : 'end'}
              className={cn('text-[11px]', selected ? 'fill-primary font-semibold' : 'fill-muted-foreground')}
            >
              {c.label}
            </text>
          </g>
        );
      })}
      <text x="352" y="268" textAnchor="end" className="fill-muted-foreground text-[11px]">
        Z homes {zDirection === 'up' ? '↑ up' : '↓ down'}
      </text>
    </svg>
  );
}

/** Isometric box labelled with the travel dimensions. */
export function EnvelopeDiagram({ x, y, z, unit }: { x: string; y: string; z: string; unit: string }) {
  // Fixed proportions keep labels readable regardless of the numbers.
  const ox = 70,
    oy = 170;
  const X = [150, 0],
    Y = [80, -50],
    Z = [0, -80];
  const p = (a: number, b: number, c: number) => [ox + X[0]! * a + Y[0]! * b + Z[0]! * c, oy + X[1]! * a + Y[1]! * b + Z[1]! * c] as const;
  const pts = (list: (readonly [number, number])[]) => list.map((q) => q.join(',')).join(' ');
  return (
    <svg viewBox="0 0 360 220" className="w-full max-w-md" aria-label="Work area box">
      <polygon points={pts([p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0)])} className="fill-muted stroke-border" strokeWidth="2" />
      <polygon points={pts([p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)])} className="fill-primary/10 stroke-primary/60" strokeWidth="1.5" strokeDasharray="4 3" />
      <polygon points={pts([p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)])} className="fill-primary/5 stroke-primary/60" strokeWidth="1.5" strokeDasharray="4 3" />
      <polygon points={pts([p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)])} className="fill-none stroke-primary/60" strokeWidth="1.5" strokeDasharray="4 3" />
      <text x={p(0.5, 0, 0)[0]} y={p(0.5, 0, 0)[1] + 20} textAnchor="middle" className="fill-foreground text-[12px] font-semibold">
        X {x} {unit}
      </text>
      <text x={p(1, 0.5, 0)[0] + 12} y={p(1, 0.5, 0)[1] + 14} className="fill-foreground text-[12px] font-semibold">
        Y {y} {unit}
      </text>
      <text x={p(0, 0, 0.5)[0] - 10} y={p(0, 0, 0.5)[1]} textAnchor="end" className="fill-foreground text-[12px] font-semibold">
        Z {z} {unit}
      </text>
      <text x="350" y="214" textAnchor="end" className="fill-muted-foreground text-[10px]">
        the space the tool tip can reach
      </text>
    </svg>
  );
}

/** Simple illustration per machine type. */
export function MachineTypeArt({ type, className }: { type: MachineType; className?: string }) {
  return (
    <svg viewBox="0 0 120 90" className={cn('h-20 w-28', className)} aria-hidden="true">
      <rect x="10" y="70" width="100" height="10" rx="2" className="fill-muted-foreground/40" />
      <rect x="18" y="14" width="84" height="8" rx="2" className="fill-muted-foreground/70" />
      <rect x="18" y="14" width="6" height="56" className="fill-muted-foreground/50" />
      <rect x="96" y="14" width="6" height="56" className="fill-muted-foreground/50" />
      {type === 'router' || type === 'router-laser' || type === 'rotary' ? (
        <g>
          <rect x={type === 'router-laser' ? 40 : 50} y="22" width="16" height="26" rx="3" className="fill-primary" />
          <rect x={type === 'router-laser' ? 46 : 56} y="48" width="4" height="12" className="fill-foreground/70" />
        </g>
      ) : null}
      {type === 'laser' || type === 'router-laser' ? (
        <g>
          <rect x={type === 'router-laser' ? 66 : 52} y="22" width="16" height="18" rx="3" className="fill-warning" />
          <line x1={type === 'router-laser' ? 74 : 60} y1="40" x2={type === 'router-laser' ? 74 : 60} y2="69" className="stroke-destructive" strokeWidth="2" />
          <circle cx={type === 'router-laser' ? 74 : 60} cy="69" r="3" className="fill-destructive/70" />
        </g>
      ) : null}
      {type === 'rotary' ? (
        <g>
          <rect x="24" y="60" width="8" height="10" className="fill-muted-foreground" />
          <rect x="88" y="60" width="8" height="10" className="fill-muted-foreground" />
          <rect x="32" y="60" width="56" height="8" rx="4" className="fill-warning/80" />
          <path d="M96 56 a6 6 0 1 1 0 -0.1" className="fill-none stroke-primary" strokeWidth="1.5" />
        </g>
      ) : (
        <rect x="34" y="62" width="52" height="8" rx="1" className="fill-warning/60" />
      )}
    </svg>
  );
}
