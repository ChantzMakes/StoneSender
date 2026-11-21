/** Small helpers for dialogs with many numeric fields shown in the profile's units. */
import { Input, Label } from '@/components/ui/primitives';
import type { Units } from '@/lib/profile/schema';
import { fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';

export type FieldKind = 'length' | 'feed' | 'plain';

export interface NumField {
  key: string;
  label: string;
  kind: FieldKind;
  /** Unit text for plain fields (%, °, rpm, s…) */
  unit?: string;
}

/** Display string for a stored value (mm, mm/min or plain). */
export function toField(v: number, kind: FieldKind, units: Units): string {
  if (kind === 'plain') return String(Number(v.toFixed(4)));
  return String(roundForDisplay(toDisplay(v, kind, units), kind, units));
}

/** Parse a field back to mm / mm/min / plain; NaN when not a number. */
export function fromField(s: string, kind: FieldKind, units: Units): number {
  const v = Number(s.replace(',', '.').trim());
  if (s.trim() === '' || !Number.isFinite(v)) return NaN;
  return kind === 'plain' ? v : fromDisplay(v, kind, units);
}

export function Fields({ fields, values, onChange, units, cols = 3, idPrefix }: { fields: NumField[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; units: Units; cols?: number; idPrefix: string }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {fields.map((f) => {
        const unit = f.kind === 'plain' ? f.unit : unitLabel(f.kind, units);
        return (
          <div key={f.key} className="flex flex-col gap-1">
            <Label htmlFor={`${idPrefix}-${f.key}`}>{f.label}</Label>
            <div className="flex items-center gap-1.5">
              <Input id={`${idPrefix}-${f.key}`} className="tabular text-right" inputMode="decimal" value={values[f.key] ?? ''} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
              {unit && <span className="w-10 text-xs text-muted-foreground">{unit}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Read all fields; returns the parsed numbers or the label of the first bad one. */
export function readFields(fields: NumField[], values: Record<string, string>, units: Units): { ok: true; v: Record<string, number> } | { ok: false; bad: string } {
  const v: Record<string, number> = {};
  for (const f of fields) {
    const n = fromField(values[f.key] ?? '', f.kind, units);
    if (!Number.isFinite(n)) return { ok: false, bad: f.label };
    v[f.key] = n;
  }
  return { ok: true, v };
}
