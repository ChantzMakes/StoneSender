import { Bug, Moon, SlidersHorizontal, Sun } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { Tip, TooltipProvider } from '@/components/ui/primitives';
import { ConnectionBar } from '@/features/connection/ConnectionBar';
import { MachineControls } from '@/features/control/MachineControls';
import { OverridesPanel } from '@/features/control/OverridesPanel';
import { JobPanel } from '@/features/job/JobPanel';
import { JogPanel } from '@/features/jog/JogPanel';
import { GrblSettingsDialog } from '@/features/settings/GrblSettingsDialog';
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
  return <PanelResizeHandle className={direction === 'horizontal' ? 'w-1 bg-border/60 transition-colors hover:bg-primary/50' : 'h-1 bg-border/60 transition-colors hover:bg-primary/50'} />;
}

export default function App() {
  const appLoaded = useApp((s) => s.loaded);
  const theme = useApp((s) => s.settings.theme);
  const devTools = useApp((s) => s.settings.devTools);
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
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
          <div className="flex items-center gap-2 pr-2">
            <img src="/app-icon.svg" alt="" className="size-7" />
            <span className="hidden font-semibold lg:inline">CNC Sender</span>
          </div>
          <ProfileSwitcher onManage={() => setManagerOpen(true)} onNew={() => setWizardOpen(true)} />
          <div className="mx-1 h-6 w-px bg-border" />
          <ConnectionBar />
          <div className="ml-auto flex items-center gap-1">
            <Tip content="Controller settings ($$): view, edit, compare with your profile, back up">
              <Button variant="ghost" size="sm" aria-label="Controller settings" data-testid="open-settings" disabled={!connected} onClick={() => openSettings('controller')}>
                <SlidersHorizontal /> <span className="hidden xl:inline">Settings</span>
              </Button>
            </Tip>
            {isTauri && (
              <Tip content={devTools ? 'Developer tools on (fault injection for the virtual machine)' : 'Developer tools off'}>
                <Button variant={devTools ? 'secondary' : 'ghost'} size="icon" aria-label="Toggle developer tools" onClick={() => updateApp((s) => ({ ...s, devTools: !s.devTools }))}>
                  <Bug />
                </Button>
              </Tip>
            )}
            <Tip content={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => updateApp((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' }))}>
                {theme === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </Tip>
            <div className="ml-2">
              <StopButton />
            </div>
          </div>
        </header>
        <Banners />
        <main className="min-h-0 flex-1">
          {profile ? (
            // autoSaveId persists panel sizes between sessions (localStorage).
            <PanelGroup direction="horizontal" autoSaveId="main-layout-v2" className="h-full">
              <Panel id="left" order={1} defaultSize={22} minSize={16} maxSize={40} className="!overflow-y-auto">
                <Dro profile={profile} />
                <div className="border-t" />
                <MachineControls profile={profile} />
                <div className="border-t" />
                <OverridesPanel profile={profile} />
              </Panel>
              <Handle direction="horizontal" />
              <Panel id="center" order={2} minSize={30}>
                <PanelGroup direction="vertical" autoSaveId="center-layout">
                  <Panel id="view" order={1} defaultSize={58} minSize={20} className="flex flex-col">
                    <Tabs value={centerTab} onValueChange={(v) => updateApp((s) => ({ ...s, centerTab: v as 'view' | 'editor' }))} className="flex min-h-0 flex-1 flex-col">
                      <div className="flex h-9 shrink-0 items-center border-b px-2">
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
                  <Handle direction="vertical" />
                  <Panel id="console" order={2} defaultSize={42} minSize={15}>
                    <Console />
                  </Panel>
                </PanelGroup>
              </Panel>
              <Handle direction="horizontal" />
              <Panel id="right" order={3} defaultSize={24} minSize={18} maxSize={40} className="!overflow-y-auto">
                <JobPanel profile={profile} />
                <div className="border-t" />
                <JogPanel profile={profile} />
              </Panel>
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
