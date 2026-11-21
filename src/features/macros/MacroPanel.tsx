/**
 * Macro buttons. Each line is sent in order and waits for the controller's
 * answer; an error, alarm or STOP ends the macro. Variables are asked for
 * before anything is sent.
 */
import { HelpButton } from '@/features/help/HelpButton';
import { Download, Pencil, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, PanelTitle, Tip } from '@/components/ui/primitives';
import { backend } from '@/lib/backend';
import { sendAndWait } from '@/lib/machine/commander';
import { expandMacro, exportMacros, type Macro, parseMacroFile, promptVariables } from '@/lib/macros';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { useApp } from '@/store/app';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { MacroEditor } from './MacroEditor';
import { MacroImportReview } from './MacroImportReview';

export function MacroPanel({ profile }: { profile: MachineProfile }) {
  const macros = useApp((s) => s.settings.macros);
  const connected = useLink((s) => s.state === 'connected');
  const jobActive = useLink((s) => isActivePhase(s.job?.phase));
  const [editOpen, setEditOpen] = useState(false);
  const [ask, setAsk] = useState<{ macro: Macro; values: Record<string, string> } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [imported, setImported] = useState<Macro[] | null>(null);
  const abort = useRef<AbortController | null>(null);

  const run = async (macro: Macro, values: Record<string, number>) => {
    const st = useLink.getState().status;
    const w = st?.wpos ?? [0, 0, 0];
    const m = st?.mpos ?? [0, 0, 0];
    const builtins = { wx: w[0], wy: w[1], wz: w[2], mx: m[0], my: m[1], mz: m[2], safeZ: profile.safety.safeZMachine, clearance: profile.safety.clearanceZ };
    const { lines, errors } = expandMacro(macro.gcode, { ...builtins, ...values });
    if (errors.length) {
      sysMessage(`Macro “${macro.name}” not run: ${errors.join(' ')}`, 'error');
      return;
    }
    const ac = new AbortController();
    abort.current = ac;
    setRunning(macro.id);
    try {
      for (const l of lines) await sendAndWait(l, ac.signal);
      sysMessage(`Macro “${macro.name}” done.`);
    } catch (e) {
      sysMessage(`Macro “${macro.name}” stopped: ${errorMessage(e)}`, 'error');
    } finally {
      setRunning(null);
    }
  };

  const start = (macro: Macro) => {
    const vars = promptVariables(macro.gcode);
    if (vars.length) setAsk({ macro, values: Object.fromEntries(vars.map((v) => [v.name, v.default ?? ''])) });
    else void run(macro, {});
  };

  const doImport = async () => {
    try {
      const f = await backend.openTextFile({ title: 'Import macros', filters: [{ name: 'Macro file', extensions: ['json'] }] });
      if (!f) return;
      const r = parseMacroFile(f.text);
      if ('error' in r) sysMessage(r.error, 'error');
      else setImported(r.macros);
    } catch (e) {
      sysMessage(errorMessage(e), 'error');
    }
  };

  return (
    <div className="flex flex-col" data-testid="macro-panel">
      <PanelTitle
        actions={
          <>
            <HelpButton section="macros" label="Help: macros" />
            <Tip content="Import macros from a file">
              <Button variant="ghost" size="icon-sm" onClick={() => void doImport()} aria-label="Import macros" data-testid="macro-import">
                <Upload />
              </Button>
            </Tip>
            <Tip content="Export your macros to share them">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Export macros"
                disabled={macros.length === 0}
                onClick={() => void backend.saveTextFile({ title: 'Export macros', defaultName: 'cnc-sender-macros.json', filters: [{ name: 'Macro file', extensions: ['json'] }], text: exportMacros(macros) }).catch((e: unknown) => sysMessage(errorMessage(e), 'error'))}
                data-testid="macro-export"
              >
                <Download />
              </Button>
            </Tip>
            <Tip content="Edit macros">
              <Button variant="ghost" size="icon-sm" onClick={() => setEditOpen(true)} aria-label="Edit macros" data-testid="macro-edit">
                <Pencil />
              </Button>
            </Tip>
          </>
        }
      >
        Macros
      </PanelTitle>
      <div className="grid grid-cols-2 gap-1.5 p-3">
        {macros.length === 0 && <p className="col-span-2 text-xs text-muted-foreground">No macros yet — add one with the pencil.</p>}
        {macros.map((m) => (
          <Tip key={m.id} content={m.description || m.gcode.split('\n').slice(0, 4).join(' · ')}>
            <span>
              <Button size="sm" variant="outline" className="w-full truncate" disabled={!connected || jobActive || running !== null} onClick={() => start(m)} data-testid={`macro-run-${m.name}`}>
                {running === m.id ? 'Running…' : m.name}
              </Button>
            </span>
          </Tip>
        ))}
        {running && (
          <Button size="sm" variant="destructive" className="col-span-2" onClick={() => abort.current?.abort()}>
            Stop sending (motion already queued finishes — use STOP to halt)
          </Button>
        )}
      </div>
      <MacroEditor open={editOpen} onOpenChange={setEditOpen} />
      <MacroImportReview macros={imported} onClose={() => setImported(null)} />
      <Dialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{ask?.macro.name}</DialogTitle>
            <DialogDescription>Values for this run. Lengths are in mm; the macro decides how they are used.</DialogDescription>
          </DialogHeader>
          {ask &&
            Object.entries(ask.values).map(([k, val]) => (
              <div key={k} className="flex flex-col gap-1">
                <Label htmlFor={`mv-${k}`}>{k}</Label>
                <Input id={`mv-${k}`} className="tabular" inputMode="decimal" value={val} onChange={(e) => setAsk({ ...ask, values: { ...ask.values, [k]: e.target.value } })} />
              </div>
            ))}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsk(null)}>
              Cancel
            </Button>
            <Button
              data-testid="macro-run-confirm"
              onClick={() => {
                if (!ask) return;
                const nums: Record<string, number> = {};
                for (const [k, v] of Object.entries(ask.values)) nums[k] = Number(v.replace(',', '.'));
                const bad = Object.entries(nums).find(([, v]) => !Number.isFinite(v));
                if (bad) {
                  sysMessage(`“${bad[0]}” must be a number.`, 'error');
                  return;
                }
                setAsk(null);
                void run(ask.macro, nums);
              }}
            >
              Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
