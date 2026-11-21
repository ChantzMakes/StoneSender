/**
 * App preferences (Phase 8): appearance, panel layout, keyboard shortcuts,
 * gamepad and a few advanced switches. Everything here changes only this
 * app — nothing is sent to the controller.
 */
import { Keyboard, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { isTauri } from '@/lib/backend';
import { bindingProblem, bindings, displayKey, keyName, SHORTCUTS, type ShortcutDef } from '@/lib/shortcuts';
import { LAYOUT_PRESETS, PANEL_LABELS, type PanelVisibility, THEMES, type ThemeChoice, UI_SCALES } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { type AppSettings, useApp } from '@/store/app';
import { type PrefsTab, useUi } from '@/store/ui';

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function PreferencesDialog() {
  const { open, tab } = useUi((s) => s.prefs);
  const close = useUi((s) => s.closePrefs);
  const openPrefs = useUi((s) => s.openPrefs);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col" data-testid="prefs-dialog">
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>How the app looks and behaves on this computer. Nothing here is sent to the controller.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(t) => openPrefs(t as PrefsTab)} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="self-start">
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="layout">Layout</TabsTrigger>
            <TabsTrigger value="shortcuts" data-testid="prefs-tab-shortcuts">
              Shortcuts
            </TabsTrigger>
            <TabsTrigger value="gamepad" data-testid="prefs-tab-gamepad">
              Gamepad
            </TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
            <TabsContent value="appearance">
              <Appearance />
            </TabsContent>
            <TabsContent value="layout">
              <Layout />
            </TabsContent>
            <TabsContent value="shortcuts">
              <Shortcuts />
            </TabsContent>
            <TabsContent value="gamepad">
              <Gamepad />
            </TabsContent>
            <TabsContent value="advanced">
              <Advanced />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Appearance() {
  const s = useApp((st) => st.settings);
  const update = useApp((st) => st.update);
  return (
    <div>
      <Row label="Theme" hint={THEMES.find((t) => t.value === s.theme)?.description}>
        <Select
          aria-label="Theme"
          className="w-56"
          value={s.theme}
          onValueChange={(v) => update((x) => ({ ...x, theme: v as ThemeChoice }))}
          options={THEMES.map((t) => ({ value: t.value, label: t.label }))}
        />
      </Row>
      <Row label="Size of text and buttons" hint="Larger is easier to read from a distance and to hit on a touch screen.">
        <div className="flex gap-1" role="radiogroup" aria-label="Interface size">
          {UI_SCALES.map((z) => (
            <Button key={z} size="sm" role="radio" aria-checked={s.uiScale === z} variant={s.uiScale === z ? 'default' : 'outline'} onClick={() => update((x) => ({ ...x, uiScale: z }))}>
              {Math.round(z * 100)} %
            </Button>
          ))}
        </div>
      </Row>
    </div>
  );
}

function Layout() {
  const layout = useApp((st) => st.settings.layout);
  const update = useApp((st) => st.update);
  const resetSizes = useUi((st) => st.resetLayoutSizes);
  const setShow = (k: keyof PanelVisibility, v: boolean) => update((x) => ({ ...x, layout: { ...x.layout, preset: 'custom', show: { ...x.layout.show, [k]: v } } }));
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 py-2">
        {LAYOUT_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            data-testid={`layout-${p.value}`}
            className={cn('rounded-lg border p-3 text-left hover:bg-accent', layout.preset === p.value && 'border-primary ring-1 ring-primary')}
            onClick={() => update((x) => ({ ...x, uiScale: p.scale ?? (x.layout.preset === 'touch' ? 1 : x.uiScale), layout: { ...x.layout, preset: p.value, show: p.show } }))}
          >
            <div className="text-sm font-medium">{p.label}</div>
            <div className="text-xs text-muted-foreground">{p.description}</div>
          </button>
        ))}
      </div>
      <div className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Panels</div>
      <p className="text-xs text-muted-foreground">The position readout and the STOP button are always shown.</p>
      {(Object.keys(PANEL_LABELS) as (keyof PanelVisibility)[]).map((k) => (
        <Row key={k} label={PANEL_LABELS[k]}>
          <Switch checked={layout.show[k]} onCheckedChange={(v) => setShow(k, v)} aria-label={`Show ${PANEL_LABELS[k]}`} data-testid={`panel-${k}`} />
        </Row>
      ))}
      <Row label="Swap sides" hint="Job and jogging on the left, position and machine controls on the right.">
        <Switch checked={layout.swapSides} onCheckedChange={(v) => update((x) => ({ ...x, layout: { ...x.layout, preset: 'custom', swapSides: v } }))} aria-label="Swap sides" />
      </Row>
      <Row label="Panel sizes" hint="Panels remember the sizes you drag them to.">
        <Button size="sm" variant="outline" onClick={resetSizes} data-testid="reset-sizes">
          <RotateCcw /> Reset sizes
        </Button>
      </Row>
    </div>
  );
}

function Shortcuts() {
  const overrides = useApp((st) => st.settings.shortcuts);
  const update = useApp((st) => st.update);
  const keys = bindings(overrides);
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const name = keyName(e);
      if (!name) return;
      const why = bindingProblem(recording, name, overrides);
      if (why) {
        setProblem({ id: recording, text: `${displayKey(name)}: ${why}` });
      } else {
        update((x) => ({ ...x, shortcuts: { ...x.shortcuts, [recording]: name } }));
        setProblem(null);
      }
      setRecording(null);
    };
    // Capture phase, ahead of STOP and the global shortcuts (the dialog is open, so the machine isn't being jogged from here).
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [recording, overrides, update]);

  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  const row = (s: ShortcutDef) => {
    const k = keys.get(s.id) ?? null;
    const changed = s.id in overrides;
    return (
      <div key={s.id} className="flex items-center gap-2 border-b py-2 last:border-b-0" data-testid={`shortcut-${s.id}`}>
        <div className="min-w-0 flex-1">
          <div className="text-sm">{s.label}</div>
          {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
          {problem?.id === s.id && <div className="text-xs text-destructive">{problem.text}</div>}
        </div>
        {s.fixed ? (
          <kbd className="rounded border bg-muted px-2 py-1 font-mono text-xs" title="Fixed">
            {displayKey(k)}
          </kbd>
        ) : (
          <>
            <Button
              size="sm"
              variant={recording === s.id ? 'default' : 'outline'}
              className="min-w-32 font-mono"
              onClick={() => {
                setProblem(null);
                setRecording(recording === s.id ? null : s.id);
              }}
              data-testid={`shortcut-set-${s.id}`}
            >
              {recording === s.id ? 'Press a key…' : displayKey(k)}
            </Button>
            <Button size="sm" variant="ghost" disabled={!k} onClick={() => update((x) => ({ ...x, shortcuts: { ...x.shortcuts, [s.id]: null } }))} aria-label={`Remove shortcut for ${s.label}`}>
              Clear
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!changed}
              onClick={() =>
                update((x) => {
                  const rest = { ...x.shortcuts };
                  delete rest[s.id];
                  return { ...x, shortcuts: rest };
                })
              }
              aria-label={`Default shortcut for ${s.label}`}
            >
              Default
            </Button>
          </>
        )}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        <Keyboard className="mr-1 inline size-3.5" />
        Click a key, then press the new key (Esc cancels). <strong>Esc is always STOP</strong> while the machine moves. Jog keys only work while <strong>Keys</strong> is on in the Jog panel — it
        is off every time the app starts. No shortcut can start a job, resume, home or set zero.
      </p>
      {groups.map((g) => (
        <div key={g}>
          <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
          {SHORTCUTS.filter((s) => s.group === g).map(row)}
        </div>
      ))}
      <div>
        <Button size="sm" variant="outline" disabled={Object.keys(overrides).length === 0} onClick={() => update((x) => ({ ...x, shortcuts: {} }))}>
          <RotateCcw /> Restore all defaults
        </Button>
      </div>
    </div>
  );
}

const PAD_BUTTONS = [
  { value: '4', label: 'LB (left bumper)' },
  { value: '5', label: 'RB (right bumper)' },
  { value: '6', label: 'LT (left trigger)' },
  { value: '7', label: 'RT (right trigger)' },
];

function Gamepad() {
  const g = useApp((st) => st.settings.gamepad);
  const update = useApp((st) => st.update);
  const set = (patch: Partial<AppSettings['gamepad']>) => update((x) => ({ ...x, gamepad: { ...x.gamepad, ...patch } }));
  return (
    <div>
      <Row label="Use a gamepad for jogging" hint="Plug in a game controller (Xbox-style layout). It can only jog — never run jobs, home or set zero.">
        <Switch checked={g.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Use a gamepad" data-testid="gamepad-enabled" />
      </Row>
      <Row label="Hold this button to jog" hint="Nothing moves unless it is held. Let go and the machine stops.">
        <Select
          aria-label="Enable button"
          className="w-48"
          disabled={!g.enabled}
          value={String(g.enableButton)}
          onValueChange={(v) => set({ enableButton: Number(v) })}
          options={PAD_BUTTONS.some((b) => b.value === String(g.enableButton)) ? PAD_BUTTONS : [...PAD_BUTTONS, { value: String(g.enableButton), label: `Button ${g.enableButton}` }]}
        />
      </Row>
      <Row label="Stick dead zone" hint="How far a stick must move before the machine does. Raise it if the machine creeps with the stick let go.">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.05}
            max={0.6}
            step={0.05}
            disabled={!g.enabled}
            value={g.deadzone}
            onChange={(e) => set({ deadzone: Number(e.target.value) })}
            aria-label="Dead zone"
            data-testid="gamepad-deadzone"
          />
          <span className="tabular w-10 text-right text-sm">{Math.round(g.deadzone * 100)} %</span>
        </div>
      </Row>
      <p className="pt-2 text-xs text-muted-foreground">Left stick: X / Y (push further = faster). Right stick up / down: Z. D-pad: one step in X / Y. Y / A: one step up / down.</p>
    </div>
  );
}

function Advanced() {
  const s = useApp((st) => st.settings);
  const update = useApp((st) => st.update);
  return (
    <div>
      <Row label="Reconnect automatically" hint="If the USB connection drops, try to reconnect. Nothing is re-sent after reconnecting.">
        <Switch checked={s.connection.autoReconnect} onCheckedChange={(v) => update((x) => ({ ...x, connection: { ...x.connection, autoReconnect: v } }))} aria-label="Reconnect automatically" />
      </Row>
      {isTauri && (
        <Row label="Developer tools" hint="Fault injection for the built-in virtual machine (testing only).">
          <Switch checked={s.devTools} onCheckedChange={(v) => update((x) => ({ ...x, devTools: v }))} aria-label="Developer tools" />
        </Row>
      )}
    </div>
  );
}
