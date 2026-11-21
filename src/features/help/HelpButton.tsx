import { CircleHelp } from 'lucide-react';
import { Tip } from '@/components/ui/primitives';
import { useUi } from '@/store/ui';

/** Small "?" that opens the user guide at a section (heading slug from lib/markdown). */
export function HelpButton({ section, label = 'Help' }: { section: string; label?: string }) {
  const openHelp = useUi((s) => s.openHelp);
  return (
    <Tip content={label}>
      <button type="button" aria-label={label} data-testid={`help-${section}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => openHelp(section)}>
        <CircleHelp className="size-3.5" />
      </button>
    </Tip>
  );
}
