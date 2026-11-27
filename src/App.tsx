import { Bug, CircleHelp, Settings2, SlidersHorizontal } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Tip, TooltipProvider } from '@/components/ui/primitives';
import { ConnectionBar } from '@/features/connection/ConnectionBar';
import { MachineControls } from '@/features/control/MachineControls';
import { OverridesPanel } from '@/features/control/OverridesPanel';
import { JobPanel } from '@/features/job/JobPanel';
import { JogPanel } from '@/features/jog/JogPanel';
import { MacroPanel } from '@/features/macros/MacroPanel';
import { GrblSettingsDialog } from '@/features/settings/GrblSettingsDialog';
import { PreferencesDialog } from '@/features/settings/PreferencesDialog';
import { HelpDialog } from '@/features/help/HelpDialog';
import { useShortcuts } from '@/features/layout/useShortcuts';
import { UpdateBanner, useStartupUpdateCheck } from '@/features/layout/UpdateBanner';
import { WcsDialog } from '@/features/wcs/WcsDialog';
import { useUi } from '@/store/ui';
import { useJobDrop } from '@/features/job/useJobDrop';
import { useAnalysisSync } from '@/store/analysis';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/primitives';

// Monaco is large: load it only when the G-code tab is opened.
const GcodeEditor = lazy(() => import('@/features/editor/GcodeEditor'));
// three.js is large too: load the 3D view on demand.
const Viewer3D = lazy(() => import('@/features/viewer/Viewer3D').then((m) => ({ default: m.Viewer3D })));
import { Console } from '@/features/console/Console';
import { Dro } from '@/features/dro/Dro';
import { Banners } from '@/features/layout/Banners';
import { StatusBar } from '@/features/layout/StatusBar';
import { ProfileManager } from '@/features/profiles/ProfileManager';
import { ProfileSwitcher } from '@/features/profiles/ProfileSwitcher';
import { StopButton } from '@/features/safety/StopButton';
import { SetupWizard } from '@/features/wizard/SetupWizard';
import { isTauri } from '@/lib/backend';
import { useApp } from '@/store/app';
import { useLink } from '@/store/link';
import { useActiveProfile, useProfiles } from '@/store/profiles';

function Handle({ direction }: { direction: 'horizontal' | 'vertical' }) {
  return <PanelResizeHandle className={direction === 'horizontal' ? 'w-1 bg-border transition-colors hover:bg-brand/60' : 'h-1 bg-border transition-colors hover:bg-brand/60'} />;
}

export default function App() {
  const appLoaded = useApp((s) => s.loaded);
  const devTools = useApp((s) => s.settings.devTools);
  const layout = useApp((s) => s.settings.layout);
  const layoutEpoch = useUi((s) => s.layoutEpoch);
  const openHelp = useUi((s) => s.openHelp);
  const openPrefs = useUi((s) => s.openPrefs);
  const updateApp = useApp((s) => s.update);
  const profilesLoaded = useProfiles((s) => s.loaded);
  const profileCount = useProfiles((s) => s.profiles.length);
  const profile = useActiveProfile();
  const connected = useLink((s) => s.state === 'connected');
  const openSettings = useUi((s) => s.openSettings);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const centerTab = useApp((s) => s.settings.centerTab);
  useAnalysisSync();
  useShortcuts();
  useStartupUpdateCheck();
  const dropping = useJobDrop();

  useEffect(() => {
    void (async () => {
      await useApp.getState().load();
      await useProfiles.getState().load();
      await useLink.getState().init();
    })();
  }, []);

  const firstRun = profilesLoaded && profileCount === 0;
  useEffect(() => {
    if (firstRun) setWizardOpen(true);
  }, [firstRun]);

  if (!appLoaded || !profilesLoaded) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        {/* Wraps instead of clipping on narrow windows / large UI sizes: STOP must always be visible. */}
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-card px-4 py-1.5">
          <div className="pr-2" aria-label="StoneSender">
            <Logo />
          </div>
          <ProfileSwitcher onManage={() => setManagerOpen(true)} onNew={() => setWizardOpen(true)} />
          <div className="mx-1 h-6 w-px bg-border" />
          <ConnectionBar />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Tip content="Controller settings ($$): view, edit, compare with your profile, back up">
              <Button variant="ghost" size="sm" aria-label="Controller settings" data-testid="open-settings" disabled={!connected} onClick={() => openSettings('controller')}>
                <SlidersHorizontal /> <span className="hidden xl:inline">Settings</span>
              </Button>
            </Tip>
            {isTauri && devTools && (
              <Tip content="Developer tools are on (fault injection for the virtual machine). Click to turn them off.">
                <Button variant="secondary" size="icon" aria-label="Turn off developer tools" onClick={() => updateApp((s) => ({ ...s, devTools: false }))}>
                  <Bug />
                </Button>
              </Tip>
            )}
            <Tip content="Preferences: theme, layout, shortcuts, gamepad (Ctrl+,)">
              <Button variant="ghost" size="icon" aria-label="Preferences" data-testid="open-prefs" onClick={() => openPrefs()}>
                <Settings2 />
              </Button>
            </Tip>
            <Tip content="Help (F1)">
              <Button variant="ghost" size="icon" aria-label="Help" data-testid="open-help" onClick={() => openHelp()}>
                <CircleHelp />
              </Button>
            </Tip>
            <div className="ml-2">
              <StopButton />
            </div>
          </div>
        </header>
        <UpdateBanner />
        <Banners />
        <main className="min-h-0 flex-1">
          {profile ? (
            // autoSaveId persists panel sizes between sessions (localStorage); the
            // layout epoch remounts everything after "Reset sizes".
            <PanelGroup key={layoutEpoch} direction="horizontal" autoSaveId={`main-layout-v3${layout.swapSides ? '-swapped' : ''}`} className="h-full">
              {(() => {
                const show = layout.show;
                const status = (order: number) => (
                  <Panel key="status" id="status" order={order} defaultSize={22} minSize={16} maxSize={40} className="bg-card !overflow-y-auto" data-testid="column-status">
                    {/* The position readout is always shown (with STOP in the header). */}
                    <Dro profile={profile} />
                    {show.machine && (
                      <>
                        <div className="border-t" />
                        <MachineControls profile={profile} />
                      </>
                    )}
                    {show.overrides && (
                      <>
                        <div className="border-t" />
                        <OverridesPanel profile={profile} />
                      </>
                    )}
                  </Panel>
                );
                const hasWork = show.job || show.jog || show.macros;
                const work = (order: number) =>
                  hasWork ? (
                    <Panel key="work" id="work" order={order} defaultSize={24} minSize={18} maxSize={40} className="bg-card !overflow-y-auto" data-testid="column-work">
                      {[
                        show.job && <JobPanel key="job" profile={profile} />,
                        show.jog && <JogPanel key="jog" profile={profile} />,
                        show.macros && <MacroPanel key="macros" profile={profile} />,
                      ]
                        .filter(Boolean)
                        .map((el, i) => (
                          <div key={i} className={i ? 'border-t' : undefined}>
                            {el}
                          </div>
                        ))}
                    </Panel>
                  ) : null;
                const center = (
                  <Panel key="center" id="center" order={2} minSize={30}>
                    <PanelGroup direction="vertical" autoSaveId={show.console ? 'center-layout' : 'center-layout-noconsole'}>
                      <Panel id="view" order={1} defaultSize={58} minSize={20} className="flex flex-col">
                        <Tabs value={centerTab} onValueChange={(v) => updateApp((s) => ({ ...s, centerTab: v as 'view' | 'editor' }))} className="flex min-h-0 flex-1 flex-col">
                          <div className="flex h-9 shrink-0 items-center border-b bg-card px-2">
                            <TabsList className="h-7 p-0.5">
                              <TabsTrigger value="view" className="py-0.5 text-xs">
                                3D view
                              </TabsTrigger>
                              <TabsTrigger value="editor" className="py-0.5 text-xs" data-testid="editor-tab">
                                G-code
                              </TabsTrigger>
                            </TabsList>
                          </div>
                          <div className="min-h-0 flex-1">
                            {centerTab === 'view' ? (
                              <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading 3D view…</div>}>
                                <Viewer3D profile={profile} />
                              </Suspense>
                            ) : (
                              <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}>
                                <GcodeEditor />
                              </Suspense>
                            )}
                          </div>
                        </Tabs>
                      </Panel>
                      {show.console && (
                        <>
                          <Handle direction="vertical" />
                          <Panel id="console" order={2} defaultSize={42} minSize={15}>
                            <Console />
                          </Panel>
                        </>
                      )}
                    </PanelGroup>
                  </Panel>
                );
                const left = layout.swapSides ? work(1) : status(1);
                const right = layout.swapSides ? status(3) : work(3);
                return [left, left && <Handle key="h1" direction="horizontal" />, center, right && <Handle key="h2" direction="horizontal" />, right];
              })()}
            </PanelGroup>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              No machine profile yet.
              <Button onClick={() => setWizardOpen(true)}>Run the setup wizard</Button>
            </div>
          )}
        </main>
        <StatusBar />
      </div>
      <SetupWizard
        open={wizardOpen}
        // Read the store, not the render-time `firstRun`: saving adds the profile just before this is called.
        onOpenChange={(o) => setWizardOpen(useProfiles.getState().profiles.length === 0 ? true : o)}
        firstRun={firstRun}
      />
      {profile && <WcsDialog profile={profile} />}
      <PreferencesDialog />
      <HelpDialog />
      {profile && <GrblSettingsDialog profile={profile} />}
      <ProfileManager
        open={managerOpen}
        onOpenChange={setManagerOpen}
        onNewProfile={() => {
          setManagerOpen(false);
          setWizardOpen(true);
        }}
      />
      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-primary bg-card px-8 py-6 text-lg font-medium shadow-xl">Drop to open the G-code file</div>
        </div>
      )}
    </TooltipProvider>
  );
}
