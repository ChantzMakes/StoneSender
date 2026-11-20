import { ChevronDown, Plus, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { useLink } from '@/store/link';
import { useActiveProfile, useProfiles } from '@/store/profiles';
import { MachineTypeArt } from '../wizard/diagrams';

export function ProfileSwitcher({ onManage, onNew }: { onManage: () => void; onNew: () => void }) {
  const profiles = useProfiles((s) => s.profiles);
  const setActive = useProfiles((s) => s.setActive);
  const active = useActiveProfile();
  const connected = useLink((s) => s.state !== 'disconnected');

  const trigger = (
    <Button variant="outline" className="h-9 max-w-64 justify-between gap-2" data-testid="profile-switcher">
      {active?.identity.icon ? <span>{active.identity.icon}</span> : active ? <MachineTypeArt type={active.machineType} className="h-5 w-7" /> : null}
      <span className="truncate">{active?.identity.name ?? 'No profile'}</span>
      <ChevronDown className="opacity-60" />
    </Button>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{connected ? 'Disconnect to switch machines' : 'Machine profiles'}</DropdownMenuLabel>
        {profiles.map((p) => (
          <DropdownMenuItem key={p.id} disabled={connected && p.id !== active?.id} onSelect={() => setActive(p.id)}>
            <span className="w-5 text-center">{p.id === active?.id ? '●' : ''}</span>
            <span className="truncate">{p.identity.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNew}>
          <Plus /> New profile (setup wizard)…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onManage} data-testid="manage-profiles">
          <Settings2 /> Manage profiles…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
