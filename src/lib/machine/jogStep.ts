/**
 * Custom jog step (owner decision: a typed step used by the jog arrows). Pure helpers so the
 * rules are unit-tested:
 *  - the typed value is in display units (mm or inch) and must be a plain positive number;
 *  - it is converted to mm and rounded to 0.0001 mm (what `stepJog` sends);
 *  - a step is never sent when it is larger than the travel of the axis it moves — it could
 *    never complete, and is almost always a typo. GRBL's own soft limits still apply on top.
 */
import { fromDisplay } from '@/lib/profile/units';
import type { Units } from '@/lib/profile/schema';

export const MIN_STEP_MM = 0.001;

export type StepParse = { mm: number; error?: undefined } | { mm?: undefined; error: string };

export function parseJogStep(text: string, units: Units): StepParse {
  const t = text.trim().replace(',', '.');
  if (!t) return { error: 'Type a distance.' };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return { error: 'Use a positive number, e.g. 2.5.' };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Use a positive number, e.g. 2.5.' };
  const mm = Math.round(fromDisplay(n, 'length', units) * 10000) / 10000;
  if (mm < MIN_STEP_MM) return { error: `Smallest step is ${units === 'inch' ? '0.0001 in' : '0.001 mm'}.` };
  return { mm };
}

/** Problem with jogging `stepMm` along the axes in `dir`, or null if it may be sent. */
export function stepTooLarge(stepMm: number, dir: [number, number, number], envelope: { x: number; y: number; z: number }): string | null {
  const axes = (['x', 'y', 'z'] as const).filter((_, i) => dir[i] !== 0);
  for (const a of axes) {
    if (stepMm > envelope[a] + 1e-9) {
      return `${a.toUpperCase()} step ${+stepMm.toFixed(4)} mm is larger than the ${a.toUpperCase()} travel (${+envelope[a].toFixed(3)} mm) — not sent.`;
    }
  }
  return null;
}
