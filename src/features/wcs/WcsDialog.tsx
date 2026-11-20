/** Work coordinate system manager: view/edit G54–G59, G92, TLO and the last probe. */
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Input } from '@/components/ui/primitives';
import { modalInches, setWcsOffset, WCS_NAMES } from '@/lib/grbl/commands';
import type { MachineProfile } from '@/lib/profile/schema';
import { formatLength, fromDisplay, toDisplay, unitLabel } from '@/lib/profile/units';
import { errorMessage } from '@/lib/utils';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { useUi } from '@/store/ui';

type Row = { x: string; y: string; z: string };

export function WcsDialog({ profile }: { profile: MachineProfile }) {
  const open = useUi((s) => s.wcsOpen);
  const setOpen = useUi((s) => s.setWcsOpen);
  const controller = useLink((s) => s.controller);
  const state = useLink((s) => s.status?.state?.name);
  const jobActive = useLink((s) => isActivePhase(s.job?.phase));
  const sendLines = useLink((s) => s.sendLines);
  const units = profile.units;
  const [edits, setEdits] = useState<Record<string, Row>>({});
  const [confirm, setConfirm] = useState<{ title: string; description: string; lines: string[] } | null>(null);

  const offsets = controller?.offsets ?? {};
  const active = controller?.parserState.find((w) => /^G5[4-9]$/.test(w)) ?? 'G54';
  const inches = modalInches(controller?.parserState);
  const canEdit = state === 'idle' && !jobActive;

  useEffect(() => {
    if (open) {
      setEdits({});
      sendLines(['$#', '$G']).catch(() => undefined);
    }
  }, [open, sendLines]);

  const shown = (name: string): Row => {
    if (edits[name]) return edits[name]!;
    const v = offsets[name] ?? [0, 0, 0];
    return { x: formatLength(v[0] ?? 0, units), y: formatLength(v[1] ?? 0, units), z: formatLength(v[2] ?? 0, units) };
  };

  const run = async (lines: string[]) => {
    try {
      await sendLines([...lines, '$#', '$G']);
    } catch (e) {
      sysMessage(errorMessage(e), 'error');
    }
  };

  const save = (index: number) => {
    const name = WCS_NAMES[index]!;
    const r = edits[name];
    if (!r) return;
    const mm = (s: string) => fromDisplay(Number(s), 'length', units);
    if ([r.x, r.y, r.z].some((s) => !Number.isFinite(Number(s)))) {
      sysMessage('Offsets must be numbers', 'error');
      return;
    }
    setConfirm({
      title: `Change ${name} offsets?`,
      description: `Sets ${name} to X ${r.x}, Y ${r.y}, Z ${r.z} ${unitLabel('length', units)} (machine coordinates of the work zero). Any job using ${name} will move to the new place.`,
      lines: [setWcsOffset(index, { x: mm(r.x), y: mm(r.y), z: mm(r.z) }, inches)],
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Work offsets</DialogTitle>
            <DialogDescription>
              Each work coordinate system (G54–G59) stores where its zero is, in machine coordinates. Values in {unitLabel('length', units)}.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 text-left">System</th>
                  <th>X</th>
                  <th>Y</th>
                  <th>Z</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {WCS_NAMES.map((name, i) => {
                  const r = shown(name);
                  const dirty = !!edits[name];
                  return (
                    <tr key={name} className="border-t" data-testid={`wcs-row-${name}`}>
                      <td className="py-1.5 pr-2 font-medium">
                        {name} {name === active && <Badge variant="info">active</Badge>}
                      </td>
                      {(['x', 'y', 'z'] as const).map((a) => (
                        <td key={a} className="px-1">
                          <Input
                            className="tabular h-8 text-right"
                            value={r[a]}
                            disabled={!canEdit}
                            aria-label={`${name} ${a.toUpperCase()}`}
                            onChange={(e) => setEdits({ ...edits, [name]: { ...r, [a]: e.target.value } })}
                          />
                        </td>
                      ))}
                      <td className="flex gap-1 py-1.5 pl-2">
                        {dirty ? (
                          <>
                            <Button size="sm" onClick={() => save(i)}>
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEdits(Object.fromEntries(Object.entries(edits).filter(([k]) => k !== name)))}>
                              Undo
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" disabled={!canEdit || name === active} onClick={() => void run([name])}>
                              Use
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!canEdit}
                              onClick={() =>
                                setConfirm({
                                  title: `Clear ${name}?`,
                                  description: `Sets ${name} back to 0, 0, 0 (its zero becomes machine zero). This cannot be undone.`,
                                  lines: [setWcsOffset(i, { x: 0, y: 0, z: 0 }, inches)],
                                })
                              }
                            >
                              Clear
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-2 rounded-md bg-muted/50 p-3 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">G92 offset</div>
              <div className="tabular font-mono">{(offsets.G92 ?? [0, 0, 0]).slice(0, 3).map((v) => formatLength(v, units)).join(', ')}</div>
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0"
                disabled={!canEdit || (offsets.G92 ?? []).every((v) => v === 0)}
                onClick={() => setConfirm({ title: 'Clear the G92 offset?', description: 'Removes the temporary G92 offset. Positions will change by the offset amount.', lines: ['G92.1'] })}
              >
                Clear G92
              </Button>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Tool length offset</div>
              <div className="tabular font-mono">{formatLength(offsets.TLO?.[0] ?? 0, units)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Last probe</div>
              <div className="tabular font-mono">
                {controller?.probe ? `${controller.probe.position.slice(0, 3).map((v) => toDisplay(v, 'length', units).toFixed(3)).join(', ')} ${controller.probe.success ? '✓' : '✗'}` : '—'}
              </div>
            </div>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-muted-foreground">{canEdit ? '' : 'Editing needs the machine Idle and no job running.'}</span>
            <Button variant="outline" size="sm" onClick={() => void sendLines(['$#', '$G']).catch(() => undefined)}>
              <RefreshCw /> Refresh
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel="Apply"
        destructive
        onConfirm={async () => {
          if (confirm) await run(confirm.lines);
          setEdits({});
        }}
      />
    </>
  );
}
