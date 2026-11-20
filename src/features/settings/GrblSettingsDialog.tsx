/**
 * Controller settings ($$) editor with profile diff/sync, backup and restore.
 *
 * Safety: nothing is written to the controller until the user ticks every
 * individual change in the confirmation list (spec §8 — this also covers
 * values coming from an imported profile or a restored backup).
 */
import { ArrowLeftRight, Download, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { backend } from '@/lib/backend';
import { applyControllerToProfile, diffProfileWithController } from '@/lib/grbl/profileSettings';
import { formatSettingValue, sameSettingValue, settingMeta, validateSettingValue } from '@/lib/grbl/settings';
import type { MachineProfile } from '@/lib/profile/schema';
import { cn, errorMessage } from '@/lib/utils';
import { sysMessage } from '@/store/console';
import { isActivePhase, useLink } from '@/store/link';
import { useProfiles } from '@/store/profiles';
import { useUi } from '@/store/ui';

interface Change {
  id: number;
  from: string | null;
  to: string;
}

const BACKUP_FORMAT = 'cnc-sender-grbl-settings';

/** Parse a backup: our JSON format, or plain `$x=value` lines (e.g. pasted from another sender). */
export function parseSettingsBackup(text: string): Record<string, string> {
  try {
    const j = JSON.parse(text) as { format?: string; settings?: Record<string, unknown> };
    if (j && j.format === BACKUP_FORMAT && j.settings) return Object.fromEntries(Object.entries(j.settings).map(([k, v]) => [k, String(v)]));
  } catch {
    /* not JSON — try $x=value lines */
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\$(\d+)\s*=\s*([-\d.]+)/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  if (Object.keys(out).length === 0) throw new Error('no settings found in that file');
  return out;
}

function WriteConfirm({ changes, onCancel, onDone }: { changes: Change[]; onCancel: () => void; onDone: () => void }) {
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const sendLines = useLink((s) => s.sendLines);
  useEffect(() => setTicked(new Set()), [changes]);
  return (
    <Dialog open={changes.length > 0} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Write to the controller?</DialogTitle>
          <DialogDescription>Tick each change you want to write. Unticked rows are skipped. Wrong values can make the machine move the wrong distance or direction.</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto" data-testid="write-confirm-list">
          {changes.map((c) => {
            const meta = settingMeta(c.id);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm hover:bg-accent">
                  <input
                    type="checkbox"
                    checked={ticked.has(c.id)}
                    onChange={(e) => {
                      const n = new Set(ticked);
                      if (e.target.checked) n.add(c.id);
                      else n.delete(c.id);
                      setTicked(n);
                    }}
                  />
                  <span className="w-12 font-mono text-xs">${c.id}</span>
                  <span className="flex-1">{meta.name}</span>
                  <span className="tabular font-mono text-xs">
                    <span className="text-muted-foreground line-through">{c.from ?? '—'}</span> → <strong>{c.to}</strong> {meta.unit}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            data-testid="write-confirm"
            disabled={ticked.size === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const lines = changes.filter((c) => ticked.has(c.id)).map((c) => `$${c.id}=${c.to}`);
                await sendLines([...lines, '$$']);
                sysMessage(`Wrote ${lines.length} setting(s) to the controller.`);
                onDone();
              } catch (e) {
                sysMessage(errorMessage(e), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Write {ticked.size} of {changes.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrblSettingsDialog({ profile }: { profile: MachineProfile }) {
  const { settingsOpen, settingsTab, closeSettings, openSettings } = useUi();
  const controller = useLink((s) => s.controller);
  const firmware = useLink((s) => s.firmware);
  const state = useLink((s) => s.status?.state?.name);
  const connected = useLink((s) => s.state === 'connected');
  const jobActive = useLink((s) => isActivePhase(s.job?.phase));
  const refresh = useLink((s) => s.refreshController);
  const saveProfile = useProfiles((s) => s.save);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Change[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmProfile, setConfirmProfile] = useState(false);

  const settings = controller?.settings ?? {};
  const ids = useMemo(() => Object.keys(settings).map(Number).sort((a, b) => a - b), [settings]);
  const canWrite = connected && (state === 'idle' || state === 'alarm') && !jobActive;
  const diff = useMemo(() => (controller ? diffProfileWithController(profile, settings) : []), [profile, settings, controller]);
  const differing = diff.filter((r) => r.differs);

  useEffect(() => {
    if (settingsOpen) setEdits({});
  }, [settingsOpen]);

  // Pre-select every differing row whenever the set of differences changes.
  // (Writing still asks for a tick per change.)
  const differingKey = differing.map((r) => r.id).join(',');
  useEffect(() => {
    setSelected(new Set(differingKey ? differingKey.split(',').map(Number) : []));
  }, [differingKey, settingsOpen]);

  const dirty = Object.entries(edits).filter(([id, v]) => settings[id] === undefined || !sameSettingValue(Number(v), Number(settings[id])));
  const invalid = dirty.filter(([id, v]) => validateSettingValue(Number(id), v));

  async function backup() {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, savedAt: new Date().toISOString(), firmware: firmware?.banner ?? null, profile: profile.identity.name, settings }, null, 2);
    const slug = profile.identity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await backend.saveTextFile({ title: 'Back up controller settings', defaultName: `${slug}-grbl-settings.json`, filters: [{ name: 'Settings backup', extensions: ['json', 'txt'] }], text });
  }

  async function restore() {
    const file = await backend.openTextFile({ title: 'Restore controller settings', filters: [{ name: 'Settings backup', extensions: ['json', 'txt'] }] });
    if (!file) return;
    const values = parseSettingsBackup(file.text);
    const next: Record<string, string> = {};
    for (const [id, v] of Object.entries(values)) {
      if (settings[id] !== undefined && !sameSettingValue(Number(v), Number(settings[id]))) next[id] = v;
    }
    setEdits(next);
    openSettings('controller');
    sysMessage(Object.keys(next).length ? `Backup loaded: ${Object.keys(next).length} setting(s) differ. Review them, then click Write.` : 'Backup loaded: it matches the controller already.');
  }

  return (
    <>
      <Dialog open={settingsOpen} onOpenChange={(o) => !o && closeSettings()}>
        <DialogContent className="h-[85vh] max-w-5xl">
          <DialogHeader>
            <DialogTitle>Controller settings</DialogTitle>
            <DialogDescription>
              {firmware ? `${firmware.kind === 'grblhal' ? 'grblHAL' : 'GRBL'} ${firmware.version}` : 'Not connected'} · {ids.length} settings
              {!canWrite && connected && ' · writing needs the machine Idle (or in Alarm) and no job running'}
            </DialogDescription>
          </DialogHeader>
          {!controller || ids.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              {connected ? 'Waiting for the controller to report its settings…' : 'Connect to a controller to see its settings.'}
              {connected && (
                <Button variant="outline" onClick={() => void refresh().catch((e) => sysMessage(errorMessage(e), 'error'))}>
                  <RefreshCw /> Read settings
                </Button>
              )}
            </div>
          ) : (
            <Tabs value={settingsTab} onValueChange={(v) => openSettings(v as 'controller' | 'compare')} className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-2">
                <TabsList>
                  <TabsTrigger value="controller">Controller ($$)</TabsTrigger>
                  <TabsTrigger value="compare" data-testid="compare-tab">
                    Compare with profile {differing.length > 0 && <Badge variant="warning">{differing.length}</Badge>}
                  </TabsTrigger>
                </TabsList>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void refresh().catch((e) => sysMessage(errorMessage(e), 'error'))}>
                    <RefreshCw /> Re-read
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void backup().catch((e) => sysMessage(errorMessage(e), 'error'))}>
                    <Download /> Back up
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!canWrite} onClick={() => void restore().catch((e) => sysMessage(errorMessage(e), 'error'))}>
                    <Upload /> Restore…
                  </Button>
                </div>
              </div>

              <TabsContent value="controller" className="flex min-h-0 flex-1 flex-col gap-2 pt-2">
                <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
                  <table className="w-full text-sm">
                    <tbody>
                      {ids.map((id) => {
                        const meta = settingMeta(id);
                        const key = String(id);
                        const value = edits[key] ?? settings[key] ?? '';
                        const err = edits[key] !== undefined ? validateSettingValue(id, edits[key]!) : null;
                        const changed = edits[key] !== undefined && !sameSettingValue(Number(edits[key]), Number(settings[key]));
                        return (
                          <tr key={id} className={cn('border-b last:border-0', changed && 'bg-warning/10')} data-testid={`setting-row-${id}`}>
                            <td className="w-14 px-2 py-1.5 font-mono text-xs text-muted-foreground">${id}</td>
                            <td className="px-2 py-1.5">
                              <div className="font-medium">{meta.name}</div>
                              <div className="text-xs text-muted-foreground">{meta.description}</div>
                              {err && <div className="text-xs text-destructive">{err}</div>}
                            </td>
                            <td className="w-36 px-2 py-1.5">
                              <Input
                                className="tabular h-8 text-right"
                                value={value}
                                disabled={!canWrite}
                                aria-label={`$${id} ${meta.name}`}
                                aria-invalid={!!err}
                                onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                              />
                            </td>
                            <td className="w-20 px-2 py-1.5 text-xs text-muted-foreground">{meta.unit}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{dirty.length ? `${dirty.length} change(s)` : 'No changes'}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={!dirty.length} onClick={() => setEdits({})}>
                      Discard
                    </Button>
                    <Button
                      data-testid="write-settings"
                      disabled={!dirty.length || invalid.length > 0 || !canWrite}
                      onClick={() => setPending(dirty.map(([id, v]) => ({ id: Number(id), from: settings[id] ?? null, to: formatSettingValue(Number(id), Number(v)) })))}
                    >
                      Write {dirty.length} change(s)…
                    </Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="compare" className="flex min-h-0 flex-1 flex-col gap-2 pt-2">
                <p className="text-sm text-muted-foreground">
                  Compares the controller with the profile “{profile.identity.name}”. Choose which side is right for each row, then copy that way.
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
                  <table className="w-full text-sm" data-testid="compare-table">
                    <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="w-8" />
                        <th className="px-2 py-1 text-left">Setting</th>
                        <th className="px-2 py-1 text-right">Profile</th>
                        <th className="px-2 py-1 text-right">Controller</th>
                        <th className="px-2 py-1 text-left">Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.map((r) => (
                        <tr key={r.id} className={cn('border-b last:border-0', r.differs && 'bg-warning/10')} data-differs={r.differs}>
                          <td className="px-2">
                            {r.differs && (
                              <input
                                type="checkbox"
                                aria-label={`Select $${r.id}`}
                                checked={selected.has(r.id)}
                                onChange={(e) => {
                                  const n = new Set(selected);
                                  if (e.target.checked) n.add(r.id);
                                  else n.delete(r.id);
                                  setSelected(n);
                                }}
                              />
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="mr-2 font-mono text-xs text-muted-foreground">${r.id}</span>
                            {r.name}
                            {r.note && <div className="text-xs text-warning">{r.note}</div>}
                          </td>
                          <td className="tabular px-2 py-1.5 text-right font-mono">{formatSettingValue(r.id, r.profileValue)}</td>
                          <td className="tabular px-2 py-1.5 text-right font-mono">{r.controllerValue === null ? 'not reported' : formatSettingValue(r.id, r.controllerValue)}</td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm" data-testid="diff-summary">
                    {differing.length === 0 ? 'The controller matches the profile.' : `${differing.length} difference(s), ${[...selected].filter((id) => differing.some((r) => r.id === id)).length} selected`}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={!differing.some((r) => selected.has(r.id))} onClick={() => setConfirmProfile(true)} data-testid="copy-to-profile">
                      <ArrowLeftRight /> Controller → profile
                    </Button>
                    <Button
                      data-testid="copy-to-controller"
                      disabled={!canWrite || !differing.some((r) => selected.has(r.id))}
                      onClick={() =>
                        setPending(
                          differing
                            .filter((r) => selected.has(r.id))
                            .map((r) => ({ id: r.id, from: r.controllerValue === null ? null : formatSettingValue(r.id, r.controllerValue), to: formatSettingValue(r.id, r.profileValue) })),
                        )
                      }
                    >
                      <ArrowLeftRight /> Profile → controller…
                    </Button>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <WriteConfirm changes={pending} onCancel={() => setPending([])} onDone={() => { setPending([]); setEdits({}); }} />

      <Dialog open={confirmProfile} onOpenChange={setConfirmProfile}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Update the profile from the controller?</DialogTitle>
            <DialogDescription>These profile values will be replaced with what the controller reports. Nothing is sent to the machine.</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1 text-sm">
            {differing
              .filter((r) => selected.has(r.id))
              .map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">${r.id}</span> {r.name}
                  </span>
                  <span className="tabular font-mono">
                    {formatSettingValue(r.id, r.profileValue)} → <strong>{r.controllerValue === null ? '—' : formatSettingValue(r.id, r.controllerValue)}</strong>
                  </span>
                </li>
              ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmProfile(false)}>
              Cancel
            </Button>
            <Button
              data-testid="confirm-copy-to-profile"
              onClick={async () => {
                try {
                  const ids = differing.filter((r) => selected.has(r.id)).map((r) => r.id);
                  await saveProfile(applyControllerToProfile(profile, settings, ids));
                  sysMessage(`Updated ${ids.length} profile value(s) from the controller.`);
                  setConfirmProfile(false);
                } catch (e) {
                  sysMessage(errorMessage(e), 'error');
                }
              }}
            >
              Update profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
