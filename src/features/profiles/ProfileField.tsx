import { Info, Lock } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Input, Label, Select, Switch, Textarea, Tip } from '@/components/ui/primitives';
import { type FieldMeta, getPath, setPath } from '@/lib/profile/fields';
import type { MachineProfile } from '@/lib/profile/schema';
import { fromDisplay, roundForDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { cn } from '@/lib/utils';

interface Props {
  meta: FieldMeta;
  profile: MachineProfile;
  onChange: (p: MachineProfile) => void;
  error?: string;
  compact?: boolean;
}

function NumberInput({ id, value, onCommit, invalid, disabled, step }: { id: string; value: number; onCommit: (v: number) => void; invalid?: boolean; disabled?: boolean; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    // Sync when the value changes from outside (e.g. units switch) but not while typing the same number.
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);
  return (
    <Input
      id={id}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      step={step}
      aria-invalid={invalid || text.trim() === '' || !Number.isFinite(Number(text))}
      className="tabular text-right"
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(',', '.'));
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

export function ProfileField({ meta, profile, onChange, error, compact }: Props) {
  const id = useId();
  const raw = getPath(profile, meta.path);
  const units = profile.units;
  const unit = meta.unit;
  const set = (v: unknown) => onChange(setPath(profile, meta.path, v));
  const readOnly = !!meta.readOnly;

  let control: React.ReactNode;
  switch (meta.kind) {
    case 'boolean':
      control = <Switch id={id} checked={Boolean(raw)} disabled={readOnly} onCheckedChange={(c) => set(c)} />;
      break;
    case 'enum': {
      const isNumber = typeof raw === 'number';
      control = (
        <Select
          id={id}
          aria-label={meta.label}
          value={String(raw)}
          disabled={readOnly}
          options={meta.options ?? []}
          onValueChange={(v) => set(isNumber ? Number(v) : v)}
        />
      );
      break;
    }
    case 'text':
      control = <Input id={id} value={(raw as string | null) ?? ''} disabled={readOnly} aria-invalid={!!error} onChange={(e) => set(meta.path === 'identity.icon' ? e.target.value || null : e.target.value)} />;
      break;
    case 'textarea':
      control = <Textarea id={id} value={String(raw ?? '')} disabled={readOnly} onChange={(e) => set(e.target.value)} />;
      break;
    case 'numberList': {
      const arr = (raw as number[]) ?? [];
      const shown = arr.map((v) => roundForDisplay(toDisplay(v, unit ?? 'length', units), unit ?? 'length', units)).join(', ');
      control = (
        <Input
          id={id}
          defaultValue={shown}
          key={`${shown}-${units}`}
          aria-invalid={!!error}
          onBlur={(e) => {
            const vals = e.target.value
              .split(/[,;\s]+/)
              .map((s) => Number(s))
              .filter((n) => Number.isFinite(n) && n > 0)
              .map((n) => fromDisplay(n, unit ?? 'length', units));
            if (vals.length) set(vals);
          }}
        />
      );
      break;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : 0;
      const shown = unit ? roundForDisplay(toDisplay(n, unit, units), unit, units) : n;
      control = (
        <div className="flex items-center gap-2">
          <NumberInput id={id} value={shown} invalid={!!error} disabled={readOnly} step={meta.step} onCommit={(v) => set(unit ? fromDisplay(v, unit, units) : v)} />
          {unit && <span className="w-16 shrink-0 text-xs text-muted-foreground">{unitLabel(unit, units)}</span>}
        </div>
      );
      break;
    }
  }

  const inline = meta.kind === 'boolean';
  return (
    <div className={cn('flex flex-col gap-1.5', compact ? 'py-1' : 'py-1.5')}>
      <div className={cn('flex gap-3', inline ? 'items-center justify-between' : 'flex-col gap-1.5')}>
        <div className="flex items-center gap-1.5">
          <Label htmlFor={id}>{meta.label}</Label>
          {readOnly && (
            <Tip content={meta.readOnly}>
              <Lock className="size-3.5 text-muted-foreground" aria-label="read-only" />
            </Tip>
          )}
          {compact && (
            <Tip content={meta.help}>
              <Info className="size-3.5 text-muted-foreground" />
            </Tip>
          )}
        </div>
        {control}
      </div>
      {!compact && <p className="text-xs leading-snug text-muted-foreground">{meta.help}</p>}
      {error && <p className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}
