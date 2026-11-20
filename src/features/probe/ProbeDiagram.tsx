/** Small animated side/top views showing what a probing routine will do before it runs. */
export type DiagramKind = 'z' | 'corner' | 'center-inside' | 'center-outside' | 'setter' | 'heightmap';

const bit = (x: number, y: number, anim: string) => (
  <g style={{ animation: `${anim} 3s ease-in-out infinite` }}>
    <rect x={x - 3} y={y - 30} width={6} height={30} rx={1} fill="var(--color-muted-foreground)" />
    <rect x={x - 8} y={y - 44} width={16} height={14} rx={2} fill="var(--color-foreground)" opacity={0.6} />
  </g>
);

export function ProbeDiagram({ kind }: { kind: DiagramKind }) {
  const stock = 'color-mix(in oklab, #c8a165 70%, transparent)';
  const plate = '#9aa7b6';
  return (
    <svg viewBox="0 -14 220 124" className="h-32 w-full rounded-md border bg-muted/40" role="img" aria-label="What the probe will do" data-testid={`diagram-${kind}`}>
      <style>{`
        @keyframes pz { 0%,15% { transform: translateY(-14px) } 45%,60% { transform: translateY(0) } 85%,100% { transform: translateY(-14px) } }
        @keyframes pc { 0%,10% { transform: translate(0,-14px) } 25% { transform: translate(0,0) } 35% { transform: translate(0,-10px) } 45% { transform: translate(-34px,-10px) } 55% { transform: translate(-34px,12px) } 70%,80% { transform: translate(-21px,12px) } 100% { transform: translate(0,-14px) } }
        @keyframes pi { 0%,10% { transform: translateX(0) } 30%,35% { transform: translateX(14px) } 60%,65% { transform: translateX(-14px) } 90%,100% { transform: translateX(0) } }
        @keyframes po { 0% { transform: translate(0,-20px) } 15% { transform: translate(32px,-20px) } 25% { transform: translate(32px,6px) } 40% { transform: translate(21px,6px) } 55% { transform: translate(32px,-20px) } 70% { transform: translate(-32px,-20px) } 80% { transform: translate(-32px,6px) } 92% { transform: translate(-21px,6px) } 100% { transform: translate(0,-20px) } }
        @keyframes ph { 0% { transform: translate(-50px,0) } 20% { transform: translate(-50px,10px) } 30% { transform: translate(-15px,0) } 45% { transform: translate(-15px,8px) } 55% { transform: translate(20px,0) } 70% { transform: translate(20px,12px) } 80% { transform: translate(50px,0) } 95% { transform: translate(50px,9px) } 100% { transform: translate(-50px,0) } }
      `}</style>
      {kind === 'z' && (
        <>
          <rect x={20} y={80} width={180} height={25} fill={stock} />
          <rect x={90} y={72} width={40} height={8} fill={plate} />
          {bit(110, 58, 'pz')}
          <text x={8} y={-3} fontSize={9} fill="currentColor">Plate on the stock: touch, back off, touch slowly → Z0</text>
        </>
      )}
      {kind === 'corner' && (
        <>
          <rect x={60} y={80} width={150} height={25} fill={stock} />
          <rect x={52} y={68} width={60} height={12} fill={plate} />
          <rect x={52} y={68} width={8} height={24} fill={plate} />
          {bit(80, 54, 'pc')}
          <text x={8} y={-3} fontSize={9} fill="currentColor">Z on top, then X (and Y) against the plate's sides</text>
        </>
      )}
      {kind === 'center-inside' && (
        <>
          <rect x={20} y={40} width={70} height={65} fill={stock} />
          <rect x={130} y={40} width={70} height={65} fill={stock} />
          {bit(110, 80, 'pi')}
          <text x={8} y={-3} fontSize={9} fill="currentColor">Inside a hole: touch both walls in X and Y → centre</text>
        </>
      )}
      {kind === 'center-outside' && (
        <>
          <rect x={20} y={95} width={180} height={10} fill={stock} />
          <rect x={85} y={65} width={50} height={30} fill={stock} />
          {bit(110, 62, 'po')}
          <text x={8} y={-3} fontSize={9} fill="currentColor">Outside a boss: drop beside each side and touch → centre</text>
        </>
      )}
      {kind === 'setter' && (
        <>
          <rect x={20} y={95} width={180} height={10} fill={stock} />
          <rect x={100} y={78} width={20} height={17} fill={plate} />
          {bit(110, 64, 'pz')}
          <text x={8} y={-3} fontSize={9} fill="currentColor">Measure the bit on the setter; the length difference moves Z0</text>
        </>
      )}
      {kind === 'heightmap' && (
        <>
          <path d="M20 88 Q 70 78 110 86 T 200 82 L200 105 L20 105 Z" fill={stock} />
          {bit(110, 70, 'ph')}
          <text x={8} y={-3} fontSize={9} fill="currentColor">Touch a grid of points; the job follows the surface</text>
        </>
      )}
    </svg>
  );
}
