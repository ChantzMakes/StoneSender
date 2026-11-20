/**
 * First-run Setup Wizard: walks a new user through creating a profile, with
 * diagrams for the confusing parts. Every step edits the same draft profile;
 * nothing is saved (and nothing is sent to a machine) until "Save profile".
 */
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/primitives';
import { FIELD_GROUPS, type FieldMeta, setPath } from '@/lib/profile/fields';
import { PRESETS, profileFromPreset } from '@/lib/profile/presets';
import { type MachineProfile, type MachineType, validateProfile } from '@/lib/profile/schema';
import { describeProfile, reviewWarnings } from '@/lib/profile/share';
import { formatLength } from '@/lib/profile/units';
import { cn, errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { useProfiles } from '@/store/profiles';
import { ProfileField } from '../profiles/ProfileField';
import { EnvelopeDiagram, HomeCornerDiagram, MachineTypeArt } from './diagrams';

const ALL_FIELDS = new Map<string, FieldMeta>(FIELD_GROUPS.flatMap((g) => g.fields.map((f) => [f.path, f] as const)));
const meta = (path: string): FieldMeta => {
  const m = ALL_FIELDS.get(path);
  if (!m) throw new Error(`unknown field ${path}`);
  return m;
};

const TYPES: { id: MachineType; title: string; text: string }[] = [
  { id: 'router', title: 'Router / mill', text: 'Cuts with a spinning bit: wood, plastic, aluminium.' },
  { id: 'laser', title: 'Laser', text: 'Engraves or cuts with a laser beam.' },
  { id: 'router-laser', title: 'Router + laser', text: 'A router with a laser module you can switch to.' },
  { id: 'rotary', title: '4-axis rotary', text: 'A router with a rotary axis (A) that turns round stock.' },
];

type StepId = 'welcome' | 'preset' | 'type' | 'area' | 'homing' | 'controller' | 'tool' | 'probe' | 'review';

const STEP_TITLES: Record<StepId, string> = {
  welcome: 'Welcome',
  preset: 'Starting point',
  type: 'Machine type',
  area: 'Work area',
  homing: 'Homing',
  controller: 'Controller',
  tool: 'Spindle / laser',
  probe: 'Probe & tool changes',
  review: 'Review & save',
};

export function SetupWizard({ open, onOpenChange, firstRun }: { open: boolean; onOpenChange: (o: boolean) => void; firstRun?: boolean }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MachineProfile>(() => profileFromPreset('generic-router', 'My machine'));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useProfiles((s) => s.save);
  const setActive = useProfiles((s) => s.setActive);
  const updateApp = useApp((s) => s.update);

  const steps: StepId[] = ['welcome', 'preset', 'type', 'area', 'homing', 'controller', 'tool', 'probe', 'review'];
  const current = steps[step]!;
  const validation = useMemo(() => validateProfile(draft), [draft]);
  const errorsFor = (prefixes: string[]) => Object.entries(validation.errors).filter(([k]) => prefixes.some((p) => k.startsWith(p)));
  const stepPrefixes: Partial<Record<StepId, string[]>> = {
    area: ['geometry'],
    homing: ['homing', 'geometry.homeCorner'],
    controller: ['controller'],
    tool: ['spindle', 'laser', 'rotary'],
    probe: ['probe', 'toolChange'],
    review: ['identity', ''],
  };
  const blocking = errorsFor(stepPrefixes[current] ?? []);

  const field = (path: string) => <ProfileField key={path} meta={meta(path)} profile={draft} onChange={setDraft} error={validation.errors[path]} />;

  function pickPreset(id: string) {
    const name = draft.identity.name;
    const p = profileFromPreset(id);
    setDraft({ ...p, identity: { ...p.identity, name: name === 'My machine' || !name ? p.identity.name : name } });
  }

  async function finish() {
    setSaving(true);
    setSaveError(null);
    try {
      await save(draft);
      setActive(draft.id);
      updateApp((s) => ({ ...s, wizardCompleted: true, activeProfileId: draft.id }));
      onOpenChange(false);
      setStep(0);
      setDraft(profileFromPreset('generic-router', 'My machine'));
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const unit = draft.units === 'inch' ? 'in' : 'mm';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 p-0" hideClose={firstRun} onInteractOutside={(e) => e.preventDefault()}>
        <div className="flex min-h-[560px]">
          {/* step rail */}
          <nav className="hidden w-52 shrink-0 flex-col gap-1 border-r bg-muted/40 p-4 md:flex" aria-label="Wizard steps">
            <div className="mb-3 text-sm font-semibold">Set up a machine</div>
            {steps.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => i < step && setStep(i)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  i === step ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground',
                  i < step && 'cursor-pointer hover:text-foreground',
                )}
              >
                <span className={cn('flex size-5 items-center justify-center rounded-full border text-[10px]', i < step && 'border-primary bg-primary text-primary-foreground')}>
                  {i < step ? <Check className="size-3" /> : i + 1}
                </span>
                {STEP_TITLES[s]}
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto p-6">
              <DialogTitle className="mb-1">{STEP_TITLES[current]}</DialogTitle>

              {current === 'welcome' && (
                <div className="flex flex-col gap-4">
                  <DialogDescription>
                    This takes about two minutes. You will describe your machine once, and the app uses it everywhere: the 3D view, safety checks, time estimates and the buttons you see. You can change any of it later.
                  </DialogDescription>
                  <div className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
                    <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
                    <div className="flex flex-col gap-1">
                      <strong>Safety first</strong>
                      <span>
                        This software never moves your machine unless you click something. Its on-screen STOP button is <em>not</em> a replacement for a physical emergency stop — keep a hardware E-stop within reach whenever the machine is powered.
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">Nothing is sent to your machine during setup. When you connect later, the app compares this profile with the controller's own settings ($$) and shows you any differences.</p>
                </div>
              )}

              {current === 'preset' && (
                <div className="flex flex-col gap-3">
                  <DialogDescription>Pick the closest match. Presets are only a starting point — every value can be edited.</DialogDescription>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        data-testid={`preset-${p.id}`}
                        onClick={() => pickPreset(p.id)}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent',
                          draft.identity.presetId === p.id && 'border-primary bg-primary/5 ring-1 ring-primary',
                        )}
                      >
                        <MachineTypeArt type={p.machineType} className="h-12 w-16 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">{p.blurb}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {current === 'type' && (
                <div className="flex flex-col gap-3">
                  <DialogDescription>This decides which controls, simulations and safety checks you get.</DialogDescription>
                  <div className="grid grid-cols-2 gap-3">
                    {TYPES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        data-testid={`type-${t.id}`}
                        onClick={() => {
                          let p = setPath(draft, 'machineType', t.id);
                          // Keep laser mode consistent with the type (safety: never on for a router).
                          if (t.id === 'laser') p = setPath(p, 'laser.laserMode', true);
                          if (t.id === 'router' || t.id === 'rotary') p = setPath(p, 'laser.laserMode', false);
                          setDraft(p);
                        }}
                        className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-4 text-center hover:bg-accent', draft.machineType === t.id && 'border-primary bg-primary/5 ring-1 ring-primary')}
                      >
                        <MachineTypeArt type={t.id} />
                        <div className="text-sm font-medium">{t.title}</div>
                        <div className="text-xs text-muted-foreground">{t.text}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {current === 'area' && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <DialogDescription className="mb-2">How far the tool can actually travel on each axis — not the outside size of the machine. If unsure, keep the preset values; you can compare with $130–$132 when you connect.</DialogDescription>
                    {field('units')}
                    {field('geometry.envelope.x')}
                    {field('geometry.envelope.y')}
                    {field('geometry.envelope.z')}
                  </div>
                  <div className="flex flex-col gap-3">
                    <EnvelopeDiagram unit={unit} x={formatLength(draft.geometry.envelope.x, draft.units, 1)} y={formatLength(draft.geometry.envelope.y, draft.units, 1)} z={formatLength(draft.geometry.envelope.z, draft.units, 1)} />
                    {field('geometry.gantryStyle')}
                    {field('geometry.dualMotorY')}
                  </div>
                </div>
              )}

              {current === 'homing' && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <DialogDescription className="mb-2">If your machine has limit switches, it can find a known position (home) by itself. Click the corner it goes to.</DialogDescription>
                    {field('homing.enabled')}
                    {field('homing.softLimits')}
                    {field('homing.hardLimits')}
                    {draft.homing.enabled && field('homing.pullOff')}
                    {field('geometry.zHomeDirection')}
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <HomeCornerDiagram value={draft.geometry.homeCorner} zDirection={draft.geometry.zHomeDirection} onChange={(c) => setDraft(setPath(draft, 'geometry.homeCorner', c))} />
                    <p className="text-xs text-muted-foreground">
                      {draft.homing.enabled ? 'Shown from above, standing at the front.' : 'No switches? Pick the corner you usually start from — it is only used for the 3D view.'}
                    </p>
                  </div>
                </div>
              )}

              {current === 'controller' && (
                <div className="flex max-w-xl flex-col gap-1">
                  <DialogDescription className="mb-2">Most GRBL boards work with the defaults. You can test everything without a machine using the built-in virtual controller.</DialogDescription>
                  {field('controller.firmware')}
                  {field('controller.baudRate')}
                  {field('controller.statusPollHz')}
                  {field('controller.streamingMode')}
                </div>
              )}

              {current === 'tool' && (
                <div className="flex max-w-xl flex-col gap-1">
                  {draft.machineType !== 'laser' && (
                    <>
                      <DialogDescription className="mb-2">What spins your bit?</DialogDescription>
                      {field('spindle.type')}
                      {field('spindle.minRpm')}
                      {field('spindle.maxRpm')}
                      {field('spindle.spinUpDelaySec')}
                    </>
                  )}
                  {(draft.machineType === 'laser' || draft.machineType === 'router-laser') && (
                    <>
                      <h3 className="mt-3 text-sm font-semibold">Laser</h3>
                      {field('laser.maxPower')}
                      {field('laser.laserMode')}
                      {field('laser.defaultM4Dynamic')}
                      {field('laser.framingPowerPercent')}
                      {field('laser.airAssist')}
                    </>
                  )}
                  {draft.machineType === 'rotary' && (
                    <>
                      <h3 className="mt-3 text-sm font-semibold">Rotary</h3>
                      {field('rotary.mode')}
                      {field('rotary.axisParallelTo')}
                      {field('rotary.defaultStockDiameter')}
                      {field('rotary.diameterHandling')}
                      {draft.rotary.mode === 'y-substitution' && field('rotary.yMmPerRevolution')}
                    </>
                  )}
                </div>
              )}

              {current === 'probe' && (
                <div className="flex max-w-xl flex-col gap-1">
                  <DialogDescription className="mb-2">Optional — skip if you do not have a touch plate. You can set this up later.</DialogDescription>
                  {field('probe.plateType')}
                  {draft.probe.plateType !== 'none' && field('probe.plateThickness')}
                  {draft.probe.plateType === 'xyz' && field('probe.xyOffset.x')}
                  {draft.probe.plateType === 'xyz' && field('probe.xyOffset.y')}
                  {draft.machineType !== 'laser' && field('toolChange.strategy')}
                </div>
              )}

              {current === 'review' && (
                <div className="flex flex-col gap-4">
                  {field('identity.name')}
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-2">
                    {describeProfile(draft).map((f) => (
                      <div key={f.label} className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{f.label}</span>
                        <span className="text-right font-medium">{f.value}</span>
                      </div>
                    ))}
                  </div>
                  {reviewWarnings(draft).map((w) => (
                    <div key={w} className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                      <AlertTriangle className="size-4 shrink-0 text-warning" />
                      {w}
                    </div>
                  ))}
                  <p className="text-sm text-muted-foreground">Saving only stores the profile on this computer. Nothing is written to your controller.</p>
                  {saveError && <p className="text-sm text-destructive">{saveError}</p>}
                </div>
              )}

              {blocking.length > 0 && current !== 'welcome' && (
                <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                  Fix before continuing: {blocking.map(([k, v]) => `${ALL_FIELDS.get(k)?.label ?? k}: ${v}`).join('; ')}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
              <div className="flex items-center gap-2">
                {!firstRun && (
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                )}
                <Badge variant="outline" className="md:hidden">
                  {step + 1}/{steps.length}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                {step > 0 && (
                  <Button variant="outline" onClick={() => setStep(step - 1)}>
                    <ArrowLeft /> Back
                  </Button>
                )}
                {step < steps.length - 1 ? (
                  <Button data-testid="wizard-next" disabled={blocking.length > 0} onClick={() => setStep(step + 1)}>
                    {current === 'welcome' ? "Let's go" : 'Next'} <ArrowRight />
                  </Button>
                ) : (
                  <Button data-testid="wizard-save" disabled={!validation.ok || saving} onClick={finish}>
                    <Check /> Save profile
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
