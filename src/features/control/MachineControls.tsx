import { HelpButton } from '@/features/help/HelpButton';
import { Crosshair, Home, LocateFixed, ParkingSquare, RotateCcw, Unlock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { PanelTitle, Tip } from '@/components/ui/primitives';
import { type Axis, goToXYZero, goToZZero, modalInches, park, zeroAxes } from '@/lib/grbl/commands';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { useUi } from '@/store/ui';
import { ProbeDialog } from '../probe/ProbeDialog';

export function MachineControls({ profile }: { profile: MachineProfile }) {
  const connected = useLink((s) => s.state === 'connected');
  const status = useLink((s) => s.status);
  const controller = useLink((s) => s.controller);
  const jobActive = useLink((s) => isActivePhase(s.job?.phase));
  const sendLines = useLink((s) => s.sendLines);
  const sendRealtime = useLink((s) => s.sendRealtime);
  const setWcsOpen = useUi((s) => s.setWcsOpen);
  const [confirmZ, setConfirmZ] = useState(false);
  const [probeOpen, setProbeOpen] = useState(false);

  const state = status?.state?.name;
  const idle = connected && state === 'idle' && !jobActive;
  const alarm = connected && state === 'alarm';
  const homingEnabled = controller?.settings['22'] !== undefined ? controller.settings['22'] === '1' : profile.homing.enabled;
  const inches = modalInches(controller?.parserState);
  const mz = status?.mpos?.[2];
  const axes: Axis[] = profile.machineType === 'rotary' && profile.rotary.mode === 'a-axis' ? ['X', 'Y', 'Z', 'A'] : ['X', 'Y', 'Z'];

  const run = (lines: string[]) =>
    sendLines(lines).catch((e) => {
      sysMessage(errorMessage(e), 'error');
    });

  return (
    <div className="flex flex-col">
      <PanelTitle actions={<HelpButton section="moving-the-machine-and-setting-zero" label="Help: homing and setting zero" />}>Machine</PanelTitle>
      <div className="flex flex-col gap-2 p-3">
        <div className="grid grid-cols-3 gap-1.5">
          <Tip content={homingEnabled ? 'Find the home switches ($H)' : 'Homing is disabled on this controller ($22=0)'}>
            <span>
              <Button size="sm" variant="secondary" className="w-full" data-testid="home-button" disabled={!(idle || alarm) || !homingEnabled} onClick={() => run(['$H'])}>
                <Home /> Home
              </Button>
            </span>
          </Tip>
          <Tip content="Clear the alarm lock ($X). Only do this if you know where the machine is.">
            <span>
              <Button size="sm" variant="secondary" className="w-full" data-testid="unlock-button" disabled={!alarm} onClick={() => run(['$X'])}>
                <Unlock /> Unlock
              </Button>
            </span>
          </Tip>
          <Tip content="Soft reset (Ctrl-X). Stops everything and clears queued commands.">
            <span>
              <Button size="sm" variant="secondary" className="w-full" disabled={!connected} onClick={() => void sendRealtime(0x18)}>
                <RotateCcw /> Reset
              </Button>
            </span>
          </Tip>
        </div>

        <div className="text-xs font-medium text-muted-foreground">Set work zero here</div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${axes.length + 1}, minmax(0, 1fr))` }}>
          {axes.map((a) => (
            <Button key={a} size="sm" variant="outline" disabled={!idle} data-testid={`zero-${a}`} onClick={() => run([zeroAxes([a])])}>
              {a}0
            </Button>
          ))}
          <Button size="sm" variant="outline" disabled={!idle} data-testid="zero-all" onClick={() => run([zeroAxes(axes)])}>
            All
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Tip content="Raise to the safe height, then move to work X0 Y0">
            <span>
              <Button size="sm" variant="outline" className="w-full" disabled={!idle} onClick={() => run(goToXYZero(profile, mz, inches))}>
                <Crosshair /> To XY0
              </Button>
            </span>
          </Tip>
          <Tip content="Lower the tool to work Z0 (asks first)">
            <span>
              <Button size="sm" variant="outline" className="w-full" disabled={!idle} onClick={() => setConfirmZ(true)}>
                <LocateFixed /> To Z0
              </Button>
            </span>
          </Tip>
          <Tip content="Raise to the safe height and move to the park position from your profile">
            <span>
              <Button size="sm" variant="outline" className="w-full" disabled={!idle} onClick={() => run(park(profile, mz, inches))}>
                <ParkingSquare /> Park
              </Button>
            </span>
          </Tip>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {profile.machineType !== 'laser' && (
            <Button size="sm" variant="outline" disabled={!idle} onClick={() => setProbeOpen(true)} data-testid="open-probe">
              Probe…
            </Button>
          )}
          <Button size="sm" variant="ghost" className={profile.machineType === 'laser' ? 'col-span-2' : ''} disabled={!connected} onClick={() => setWcsOpen(true)} data-testid="open-wcs">
            Work offsets…
          </Button>
        </div>
      </div>
      {profile.machineType !== 'laser' && <ProbeDialog open={probeOpen} onOpenChange={setProbeOpen} profile={profile} />}
      <ConfirmDialog
        open={confirmZ}
        onOpenChange={setConfirmZ}
        title="Move down to work Z0?"
        description="The tool will move straight down to the work zero height. Make sure nothing is in the way and the bit will not crash into the stock or a clamp."
        confirmLabel="Move to Z0"
        onConfirm={() => run(goToZZero())}
      />
    </div>
  );
}
