/**
 * Transform the loaded job: translate, rotate, mirror, scale, arcs → lines,
 * feed scaling. The result opens as a new file (`<name>-<what>.nc`); the
 * original stays on disk. Check it in the 3D view before running.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label, Select } from '@/components/ui/primitives';
import { transformGcode, type Transform } from '@/lib/gcode/transform';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { useAnalysis } from '@/store/analysis';
import { sysMessage } from '@/store/console';
import { useLink } from '@/store/link';
import { Fields, type NumField, readFields, toField } from './NumberFields';

type Kind = Transform['kind'];

const KINDS: { value: Kind; label: string; suffix: string }[] = [
  { value: 'translate', label: 'Move (translate)', suffix: 'moved' },
  { value: 'rotate', label: 'Rotate', suffix: 'rotated' },
  { value: 'mirror', label: 'Mirror', suffix: 'mirrored' },
  { value: 'scale', label: 'Scale', suffix: 'scaled' },
  { value: 'arcs-to-lines', label: 'Arcs → lines', suffix: 'lines' },
  { value: 'feed', label: 'Scale feeds', suffix: 'feeds' },
];

const FIELDS: Record<Exclude<Kind, 'mirror'>, NumField[]> = {
  translate: [
    { key: 'dx', label: 'X by', kind: 'length' },
    { key: 'dy', label: 'Y by', kind: 'length' },
    { key: 'dz', label: 'Z by', kind: 'length' },
  ],
  rotate: [
    { key: 'angleDeg', label: 'Angle (counter-clockwise)', kind: 'plain', unit: '°' },
    { key: 'cx', label: 'Around X', kind: 'length' },
    { key: 'cy', label: 'Around Y', kind: 'length' },
  ],
  scale: [
    { key: 'sx', label: 'X factor', kind: 'plain', unit: '×' },
    { key: 'sy', label: 'Y factor', kind: 'plain', unit: '×' },
    { key: 'sz', label: 'Z factor', kind: 'plain', unit: '×' },
    { key: 'cx', label: 'From X', kind: 'length' },
    { key: 'cy', label: 'From Y', kind: 'length' },
  ],
  'arcs-to-lines': [{ key: 'tolerance', label: 'Max deviation', kind: 'length' }],
  feed: [{ key: 'factor', label: 'Feed factor', kind: 'plain', unit: '×' }],
};
const MIRROR: NumField[] = [{ key: 'about', label: 'Mirror line at', kind: 'length' }];

export function TransformDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: MachineProfile }) {
  const units = profile.units;
  const loaded = useLink((s) => s.loadedJob);
  const text = useLink((s) => s.jobText);
  const analysis = useAnalysis((s) => s.result);
  const [kind, setKind] = useState<Kind>('translate');
  const [axis, setAxis] = useState<'x' | 'y'>('x');
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const b = analysis?.stats.cutBounds;
    const cx = b && !b.empty ? (b.min[0] + b.max[0]) / 2 : 0;
    const cy = b && !b.empty ? (b.min[1] + b.max[1]) / 2 : 0;
    const mm: Record<string, number> = { dx: 0, dy: 0, dz: 0, angleDeg: 90, cx, cy, sx: 1, sy: 1, sz: 1, tolerance: 0.01, factor: 1, about: cx };
    const all = [...Object.values(FIELDS).flat(), ...MIRROR];
    const next: Record<string, string> = {};
    for (const f of all) next[f.key] = toField(mm[f.key] ?? 0, f.kind, units);
    setV(next);
    setError(null);
  }, [open]);

  const fields = kind === 'mirror' ? MIRROR : FIELDS[kind];
  const apply = async () => {
    if (!text || !loaded) return;
    const r = readFields(fields, v, units);
    if (!r.ok) {
      setError(`“${r.bad}” must be a number.`);
      return;
    }
    const n = r.v;
    let t: Transform;
    switch (kind) {
      case 'translate':
        t = { kind, dx: n.dx!, dy: n.dy!, dz: n.dz! };
        break;
      case 'rotate':
        t = { kind, angleDeg: n.angleDeg!, cx: n.cx!, cy: n.cy! };
        break;
      case 'mirror':
        t = { kind, axis, about: n.about! };
        break;
      case 'scale':
        if ([n.sx, n.sy, n.sz].some((x) => !x)) return setError('Scale factors must not be zero.');
        t = { kind, sx: n.sx!, sy: n.sy!, sz: n.sz!, cx: n.cx!, cy: n.cy! };
        break;
      case 'arcs-to-lines':
        if (!(n.tolerance! > 0)) return setError('The deviation must be above zero.');
        t = { kind, tolerance: n.tolerance! };
        break;
      default:
        if (!(n.factor! > 0)) return setError('The feed factor must be above zero.');
        t = { kind: 'feed', factor: n.factor! };
    }
    const res = transformGcode(text, t);
    if (res.errors.length) {
      setError(`Can't transform this job: ${res.errors.slice(0, 3).join(' ')}`);
      return;
    }
    const suffix = KINDS.find((k) => k.value === kind)!.suffix;
    const name = loaded.name.replace(/(\.[^.]+)?$/, (ext) => `-${suffix}${ext || '.nc'}`);
    try {
      await useLink.getState().loadJobText(name, res.text);
      for (const w of res.warnings) sysMessage(w, 'warn');
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Transform the job</DialogTitle>
          <DialogDescription>Creates a changed copy of “{loaded?.name}” and opens it. Positions are work coordinates. Check the result in the 3D view before running.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label>Transform</Label>
            <Select aria-label="Transform" value={kind} options={KINDS} onValueChange={(k) => setKind(k as Kind)} />
          </div>
          {kind === 'mirror' && (
            <div className="flex flex-col gap-1">
              <Label>Flip</Label>
              <Select aria-label="Mirror axis" value={axis} options={[{ value: 'x', label: 'Left ↔ right (X)' }, { value: 'y', label: 'Front ↔ back (Y)' }]} onValueChange={(a) => setAxis(a as 'x')} />
            </div>
          )}
        </div>
        <Fields fields={fields} values={v} onChange={setV} units={units} idPrefix="tr" />
        {kind === 'scale' && <p className="text-xs text-muted-foreground">Different X and Y factors turn arcs into short lines. Scaling Z changes cut depths — check the result.</p>}
        {kind === 'feed' && <p className="text-xs text-muted-foreground">Multiplies every F word. Feed overrides during the job do the same thing live.</p>}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} data-testid="transform-apply">
            Create transformed copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
