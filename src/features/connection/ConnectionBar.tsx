import { Bug, Cpu, Plug, PlugZap, RefreshCw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { Select, Tip } from '@/components/ui/primitives';
import { backend, isTauri, type FaultRequest, type VirtualFlavor } from '@/lib/backend';
import { cn, errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { useLink, VIRTUAL_PORT } from '@/store/link';
import { useActiveProfile } from '@/store/profiles';

const FLAVORS: { value: VirtualFlavor; label: string }[] = [
  { value: 'grbl11', label: 'GRBL 1.1' },
  { value: 'grblhal', label: 'grblHAL' },
  { value: 'grbl09', label: 'GRBL 0.9 (old)' },
];

export function ConnectionBar() {
  const profile = useActiveProfile();
  const { state, ports, portsLoading, refreshPorts, connect, disconnect } = useLink();
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.update);
  const [port, setPort] = useState<string>(settings.connection.lastPort ?? VIRTUAL_PORT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings.connection.lastPort) setPort(settings.connection.lastPort);
  }, [settings.connection.lastPort]);

  const connected = state !== 'disconnected';
  const options = [
    { value: VIRTUAL_PORT, label: isTauri ? 'Virtual machine (simulated)' : 'Browser preview (simulated)' },
    ...ports.map((p) => ({ value: p.path, label: `${p.label}${p.likelyGrbl ? ' ★' : ''}` })),
  ];
  if (port !== VIRTUAL_PORT && !ports.some((p) => p.path === port)) options.push({ value: port, label: `${port} (not found)` });

  async function toggle() {
    if (!profile) return;
    setBusy(true);
    try {
      if (connected) await disconnect();
      else await connect(port, profile);
    } catch {
      /* already reported in the console */
    } finally {
      setBusy(false);
    }
  }

  async function fault(f: FaultRequest) {
    try {
      await backend.injectFault(f);
      sysMessage(`Injected fault: ${f.kind}`, 'warn');
    } catch (e) {
      sysMessage(errorMessage(e), 'error');
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="w-64">
        <Select aria-label="Port" value={port} disabled={connected} options={options} onValueChange={setPort} />
      </div>
      <Tip content="Rescan serial ports">
        <Button variant="ghost" size="icon" disabled={connected || portsLoading} onClick={refreshPorts} aria-label="Rescan ports">
          <RefreshCw className={cn(portsLoading && 'animate-spin')} />
        </Button>
      </Tip>
      {port === VIRTUAL_PORT && !connected && (
        <div className="w-36">
          <Select
            aria-label="Virtual firmware"
            value={settings.connection.virtualFlavor}
            options={FLAVORS}
            onValueChange={(v) => update((s) => ({ ...s, connection: { ...s.connection, virtualFlavor: v as VirtualFlavor } }))}
          />
        </div>
      )}
      <Button data-testid="connect-button" variant={connected ? 'outline' : 'default'} disabled={!profile || busy || state === 'connecting'} onClick={toggle} className="w-36">
        {connected ? (
          <>
            <Unplug /> Disconnect
          </>
        ) : (
          <>
            {port === VIRTUAL_PORT ? <Cpu /> : <Plug />} Connect
          </>
        )}
      </Button>
      {settings.devTools && port === VIRTUAL_PORT && connected && isTauri && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Inject fault">
              <Bug />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Virtual controller faults</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => fault({ kind: 'disconnect' })}>
              <PlugZap /> Unplug USB
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fault({ kind: 'alarm', code: 1 })}>Hard limit (ALARM:1)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fault({ kind: 'alarm', code: 9 })}>Homing fail (ALARM:9)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fault({ kind: 'errorOnNextLine', code: 20 })}>Error on next line (error:20)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fault({ kind: 'dropNextOk' })}>Swallow next "ok"</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => fault({ kind: 'stall', seconds: 3 })}>Stall 3 s</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
