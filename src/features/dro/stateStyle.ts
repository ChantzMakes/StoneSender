/**
 * Machine-state pill (design system StatusBadge): a dot AND a word on a sunken pill; colour is
 * never the only cue. Kept free of stores so the pop-out status window can use it too.
 */
export const STATE_STYLE: Record<string, { label: string; tone: string }> = {
  idle: { label: 'Idle', tone: 'text-muted-foreground' },
  run: { label: 'Running', tone: 'text-run' },
  jog: { label: 'Jogging', tone: 'text-run' },
  home: { label: 'Homing', tone: 'text-run' },
  hold: { label: 'Hold', tone: 'text-hold' },
  door: { label: 'Door open', tone: 'text-hold' },
  check: { label: 'Check mode', tone: 'text-muted-foreground' },
  sleep: { label: 'Sleep', tone: 'text-muted-foreground' },
  tool: { label: 'Tool change', tone: 'text-hold' },
  alarm: { label: 'Alarm', tone: 'text-alarm' },
  unknown: { label: 'Unknown', tone: 'text-muted-foreground' },
};

export const STATE_PILL =
  'inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 text-xs font-semibold tracking-[0.04em] whitespace-nowrap uppercase before:size-2 before:shrink-0 before:rounded-full before:content-[""]';

/** Hollow dot for "no controller" */
export const OFFLINE_DOT = 'text-muted-foreground before:shadow-[inset_0_0_0_1.5px_currentColor]';

export function stateText(state: { name: string; sub?: number | string }): { label: string; tone: string } {
  const s = STATE_STYLE[state.name] ?? STATE_STYLE.unknown!;
  const sub = state.name === 'hold' ? (state.sub === 1 ? ' (stopping)' : '') : state.name === 'door' && state.sub !== undefined ? ` ${state.sub}` : '';
  return { label: s.label + sub, tone: s.tone };
}
