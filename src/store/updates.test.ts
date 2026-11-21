import { describe, expect, it } from 'vitest';
import { useLink } from './link';
import { APP_VERSION, canInstallNow, useUpdates } from './updates';

describe('updates', () => {
  it('never installs while connected to a machine', () => {
    useLink.setState({ state: 'disconnected' });
    expect(canInstallNow().ok).toBe(true);
    for (const state of ['connecting', 'connected'] as const) {
      useLink.setState({ state } as never);
      expect(canInstallNow()).toMatchObject({ ok: false, reason: expect.stringMatching(/Disconnect/) });
    }
    useLink.setState({ state: 'disconnected' });
  });

  it('knows its version and explains that the browser preview cannot update', async () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    await useUpdates.getState().check();
    expect(useUpdates.getState()).toMatchObject({ status: 'error', error: expect.stringMatching(/installed app/) });
    await useUpdates.getState().check({ quiet: true }); // a quiet check stays quiet
  });
});
