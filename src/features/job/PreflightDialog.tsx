/** Pre-flight check shown before every run or check — spec §8. */
import { AlertTriangle, CheckCircle2, Info, OctagonX, Play, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { JobMode } from '@/lib/backend';
import { isBlocked, preflight, type CheckLevel } from '@/lib/job/preflight';
import type { MachineProfile } from '@/lib/profile/schema';
import { errorMessage } from '@/lib/utils';
import { machineBounds } from '@/lib/profile/geometry';
import { runChecks } from '@/lib/sim/checks';
import { defaultStock, stockBox } from '@/lib/sim/setup';
import { useAnalysis } from '@/store/analysis';
import { useRemoval } from '@/store/removal';
import { useSim } from '@/store/sim';
import { useSimTool } from '../viewer/useSimSetup';
import { useLink } from '@/store/link';

const ICON: Record<CheckLevel, React.ReactNode> = {
  block: <OctagonX className="size-4 text-destructive" />,
  warn: <AlertTriangle className="size-4 text-warning" />,
  ok: <CheckCircle2 className="size-4 text-success" />,
  info: <Info className="size-4 text-info" />,
};
const ORDER: CheckLevel[] = ['block', 'warn', 'info', 'ok'];

export function PreflightDialog({ mode, profile, onClose }: { mode: JobMode | null; profile: MachineProfile; onClose: () => void }) {
  const loaded = useLink((s) => s.loadedJob);
  const controller = useLink((s) => s.controller);
  const status = useLink((s) => s.status);
  const startJob = useLink((s) => s.startJob);
  const analysis = useAnalysis((s) => s.result);
  const analysisStatus = useAnalysis((s) => s.status);
  const simStock = useSim((s) => s.stock);
  const tool = useSimTool(profile);
  const wcoKey = status?.wco?.join(',');
  // Collision / limit checks against the stock, placed with the live work offset.
  const sim = useMemo(() => {
    const wco = status?.wco;
    if (!analysis || !wco || wco.length < 3) return null;
    const stock = simStock ?? defaultStock(profile);
    const b = machineBounds(profile);
    const checks = runChecks({
      tp: analysis.toolpath,
      wco: [wco[0]!, wco[1]!, wco[2]!],
      bounds: { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] },
      stock: profile.machineType === 'rotary' ? null : stockBox(stock),
      toolRadius: tool.diameter / 2,
      laser: profile.machineType === 'laser',
    });
    return { checks, stock };
    // Re-run only when the offset, stock or job changes — not on every status report.
  }, [analysis, profile, simStock, tool, wcoKey]);
  // Laser burn simulation has nothing to report here.
  const removalReady = useRemoval((s) => s.status === 'ready' && s.mode !== 'laser');
  const removalEvents = useRemoval((s) => s.events);
  const removal = removalReady ? removalEvents : null;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checks = useMemo(
    () => (loaded && mode ? preflight({ scan: loaded.scan, profile, controller, status, mode, analysis, analysisStatus, sim, removal }) : []).sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level)),
    // Status arrives several times a second; re-evaluate only when state or offsets change.
    [loaded, mode, profile, controller, analysis, analysisStatus, sim, removal, status?.state?.name, status?.wco?.join(',')],
  );
  const blocked = isBlocked(checks);
  const needsAck = mode === 'run';

  return (
    <Dialog
      open={!!mode}
      onOpenChange={(o) => {
        if (!o) {
          setAck(false);
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'check' ? 'Check job (dry run)' : 'Ready to run?'}</DialogTitle>
          <DialogDescription>
            {loaded?.name} · {loaded?.scan.lines.toLocaleString()} lines · profile “{profile.identity.name}”
            {mode === 'check' && ' — the controller reads every line in check mode ($C) without moving.'}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[45vh] flex-col gap-1.5 overflow-y-auto" data-testid="preflight-list">
          {checks.map((c) => (
            <li key={c.id} className="flex gap-2 rounded-md border p-2 text-sm" data-level={c.level}>
              <span className="mt-0.5">{ICON[c.level]}</span>
              <div>
                <div className="font-medium">{c.title}</div>
                {c.detail && <div className="text-xs whitespace-pre-line text-muted-foreground">{c.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
        {needsAck && !blocked && (
          <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="preflight-ack" />
            <span>
              I have checked that the work zero is set, the right bit (or laser) is fitted, the stock is held down, and I can reach the hardware E-stop.
            </span>
          </label>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="preflight-start"
            disabled={blocked || (needsAck && !ack) || busy}
            onClick={async () => {
              if (!mode) return;
              setBusy(true);
              setError(null);
              try {
                await startJob(mode);
                setAck(false);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === 'check' ? <ShieldCheck /> : <Play />} {blocked ? 'Fix the problems above first' : mode === 'check' ? 'Start check' : 'Start job'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
