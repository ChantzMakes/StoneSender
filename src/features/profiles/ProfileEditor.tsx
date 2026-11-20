/** Full profile settings editor, generated from FIELD_GROUPS. */
import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/primitives';
import { visibleGroups } from '@/lib/profile/fields';
import { type MachineProfile, validateProfile } from '@/lib/profile/schema';
import { cn, errorMessage } from '@/lib/utils';
import { useProfiles } from '@/store/profiles';
import { HomeCornerDiagram } from '../wizard/diagrams';
import { ProfileField } from './ProfileField';

export function ProfileEditor({ profile }: { profile: MachineProfile }) {
  const [draft, setDraft] = useState(profile);
  const [group, setGroup] = useState('identity');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const save = useProfiles((s) => s.save);

  useEffect(() => {
    setDraft(profile);
    setStatus(null);
  }, [profile]);

  const validation = useMemo(() => validateProfile(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);
  const groups = visibleGroups(draft);
  const active = groups.find((g) => g.id === group) ?? groups[0]!;
  const groupErrors = (id: string) => {
    const g = groups.find((x) => x.id === id);
    return g ? g.fields.filter((f) => validation.errors[f.path]).length : 0;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2" aria-label="Settings groups">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setGroup(g.id)}
              className={cn('flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', active.id === g.id && 'bg-accent font-medium')}
            >
              {g.title}
              {groupErrors(g.id) > 0 && <span className="size-2 rounded-full bg-destructive" aria-label="has errors" />}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold">{active.title}</h3>
              <p className="text-sm text-muted-foreground">{active.description}</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              Show advanced
              <Switch checked={showAdvanced} onCheckedChange={setShowAdvanced} />
            </label>
          </div>
          {active.id === 'geometry' && (
            <div className="mb-3 flex justify-center">
              <HomeCornerDiagram value={draft.geometry.homeCorner} zDirection={draft.geometry.zHomeDirection} onChange={(c) => setDraft({ ...draft, geometry: { ...draft.geometry, homeCorner: c } })} />
            </div>
          )}
          <div className="grid max-w-3xl grid-cols-1 gap-x-6 xl:grid-cols-2">
            {active.fields
              .filter((f) => (showAdvanced || !f.advanced) && (!f.showIf || f.showIf(draft)))
              .map((f) => (
                <ProfileField key={f.path} meta={f} profile={draft} onChange={setDraft} error={validation.errors[f.path]} />
              ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
        <div className="text-sm">
          {status && <span className={status.kind === 'ok' ? 'text-success' : 'text-destructive'}>{status.text}</span>}
          {!validation.ok && !status && <span className="text-destructive">{Object.keys(validation.errors).length} field(s) need attention</span>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty} onClick={() => setDraft(profile)}>
            <RotateCcw /> Revert
          </Button>
          <Button
            data-testid="profile-save"
            disabled={!dirty || !validation.ok}
            onClick={async () => {
              try {
                await save(draft);
                setStatus({ kind: 'ok', text: 'Saved.' });
              } catch (e) {
                setStatus({ kind: 'error', text: errorMessage(e) });
              }
            }}
          >
            <Save /> Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
