/** Prominent notices: connection loss, alarms, legacy firmware, controller/profile mismatches. */
import { AlertTriangle, Home, OctagonAlert, PlugZap, Unlock, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { alarmInfo, alarmLosesPosition } from '@/lib/grbl/codes';
import { diffProfileWithController, machineTypeMismatch } from '@/lib/grbl/profileSettings';
import { errorMessage } from '@/lib/utils';
import { sysMessage } from '@/store/console';
import { useLink } from '@/store/link';
import { useActiveProfile, useProfiles } from '@/store/profiles';
import { useUi } from '@/store/ui';

function Banner({ tone, icon, children, onDismiss, testId }: { tone: 'error' | 'warn'; icon: React.ReactNode; children: React.ReactNode; onDismiss?: () => void; testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={tone === 'error' ? 'flex items-start gap-3 border-b border-destructive/40 bg-destructive/15 px-4 py-2 text-sm' : 'flex items-start gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm'}
    >
      <span className={tone === 'error' ? 'mt-0.5 text-destructive' : 'mt-0.5 text-warning'}>{icon}</span>
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">
          <X />
        </Button>
      )}
    </div>
  );
}

function AlarmBanner() {
  const status = useLink((s) => s.status);
  const lastAlarm = useLink((s) => s.lastAlarm);
  const controller = useLink((s) => s.controller);
  const sendLine = useLink((s) => s.sendLine);
  const profile = useActiveProfile();
  if (status?.state?.name !== 'alarm') return null;
  const info = alarmInfo(lastAlarm?.code);
  const homing = controller?.settings['22'] !== undefined ? controller.settings['22'] === '1' : (profile?.homing.enabled ?? false);
  const lost = alarmLosesPosition(lastAlarm?.code);
  const run = (l: string) => sendLine(l).catch((e) => sysMessage(errorMessage(e), 'error'));
  return (
    <Banner tone="error" icon={<OctagonAlert className="size-4" />} testId="alarm-banner">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-64 flex-1">
          <strong>{lastAlarm ? `ALARM:${lastAlarm.code ?? lastAlarm.text}${info ? ` — ${info.title}` : ''}` : 'Controller is locked (alarm)'}</strong>{' '}
          {info ? `${info.meaning} ${info.fix}` : homing ? 'Homing is enabled, so the controller starts locked until you home it.' : 'Unlock it once you are sure where the machine is.'}
        </div>
        <div className="flex gap-2">
          {homing && (
            <Button size="sm" onClick={() => void run('$H')}>
              <Home /> Home
            </Button>
          )}
          <Button size="sm" variant={homing || lost ? 'outline' : 'default'} onClick={() => void run('$X')}>
            <Unlock /> {lost ? 'Unlock anyway' : 'Unlock'}
          </Button>
        </div>
      </div>
    </Banner>
  );
}

export function Banners() {
  const state = useLink((s) => s.state);
  const message = useLink((s) => s.message);
  const firmware = useLink((s) => s.firmware);
  const controller = useLink((s) => s.controller);
  const connectedProfileId = useLink((s) => s.connectedProfileId);
  const problems = useProfiles((s) => s.loadProblems);
  const notices = useProfiles((s) => s.notices);
  const profile = useActiveProfile();
  const openSettings = useUi((s) => s.openSettings);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const dismiss = (k: string) => setDismissed((d) => new Set(d).add(k));

  const connected = state === 'connected';
  const settings = controller?.settings ?? {};
  const haveSettings = Object.keys(settings).length > 0;
  const mismatches = connected && profile && haveSettings ? machineTypeMismatch(profile, settings) : [];
  const diffCount = connected && profile && haveSettings ? diffProfileWithController(profile, settings).filter((r) => r.differs).length : 0;
  const diffKey = `diff:${connectedProfileId}:${diffCount}`;

  return (
    <>
      {(state === 'lost' || state === 'reconnecting') && (
        <Banner tone="error" icon={<PlugZap className="size-4" />}>
          <strong>Connection to the controller was lost.</strong> {message} Streaming has stopped and nothing will be re-sent automatically. Before continuing: check the machine has stopped, then reconnect and re-home (or re-zero) — the controller has
          most likely reset and lost its position.
        </Banner>
      )}
      {state === 'disconnected' && message && !dismissed.has(`msg:${message}`) && (
        <Banner tone="warn" icon={<AlertTriangle className="size-4" />} onDismiss={() => dismiss(`msg:${message}`)}>
          {message}
        </Banner>
      )}
      {connected && <AlarmBanner />}
      {mismatches.map((m) => (
        <Banner key={m.message} tone={m.severity === 'danger' ? 'error' : 'warn'} icon={<AlertTriangle className="size-4" />} testId="mismatch-banner">
          {m.message}{' '}
          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => openSettings('controller')}>
            Open controller settings
          </Button>
        </Banner>
      ))}
      {diffCount > 0 && !dismissed.has(diffKey) && (
        <Banner tone="warn" icon={<AlertTriangle className="size-4" />} onDismiss={() => dismiss(diffKey)} testId="diff-banner">
          {diffCount} controller setting(s) differ from the profile “{profile?.identity.name}”.{' '}
          <Button size="sm" variant="link" className="h-auto p-0" onClick={() => openSettings('compare')}>
            Review differences
          </Button>
        </Banner>
      )}
      {firmware?.legacy && connected && !dismissed.has('legacy') && (
        <Banner tone="warn" icon={<AlertTriangle className="size-4" />} onDismiss={() => dismiss('legacy')}>
          <strong>Old firmware: {firmware.banner}.</strong> {firmware.warnings.join(' ')}
        </Banner>
      )}
      {problems.map((p) =>
        dismissed.has(p) ? null : (
          <Banner key={p} tone="warn" icon={<AlertTriangle className="size-4" />} onDismiss={() => dismiss(p)}>
            {p}
          </Banner>
        ),
      )}
      {notices.map((n) =>
        dismissed.has(n) ? null : (
          <Banner key={n} tone="warn" icon={<AlertTriangle className="size-4" />} onDismiss={() => dismiss(n)}>
            {n}
          </Banner>
        ),
      )}
    </>
  );
}
