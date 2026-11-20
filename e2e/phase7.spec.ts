import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

async function console(page: Page, ...cmds: string[]) {
  for (const cmd of cmds) {
    await page.getByTestId('console-input').fill(cmd);
    await page.getByTestId('console-input').press('Enter');
  }
}

async function openSample(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-job').click();
  await (await chooser).setFiles(path.resolve('samples/gcode', name));
  await expect(page.getByTestId('job-name')).toHaveText(name);
}

test.beforeEach(async ({ page }) => {
  // Long flows; headless Chromium renders the 3D view and simulation in software.
  test.slow();
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
});

test('Z plate probing needs the touch test, then sets Z zero', async ({ page }) => {
  await connectDemo(page);
  // The preview's stock top is at machine Z −32 (40 % down the 80 mm travel); max probe distance is 25 mm.
  await console(page, '$J=G91 Z-20 F1000');
  await expect(page.getByTestId('dro-work-Z')).toHaveText('-20.000');
  await page.getByTestId('open-probe').click();
  await page.getByRole('tab', { name: 'Z plate' }).click();
  await expect(page.getByTestId('probe-z')).toBeDisabled();
  await page.getByTestId('simulate-touch').click();
  await expect(page.getByTestId('touch-test')).toContainText('Probe connection works');
  await page.getByTestId('probe-z').click();
  await expect(page.getByTestId('probe-result')).toContainText('Z zero set');
  // Touch at −32 with a 15 mm plate → the machine retracts 3 + 2 mm: work Z = 15 + 5
  await expect(page.getByTestId('dro-work-Z')).toHaveText('20.000');
  // The test is needed again before the next probe.
  await expect(page.getByTestId('probe-z')).toBeDisabled();
});

test('a probe that touches nothing raises the alarm and reports it', async ({ page }) => {
  await connectDemo(page);
  await page.getByTestId('open-probe').click();
  await page.getByRole('tab', { name: 'Z plate' }).click();
  await page.getByTestId('simulate-touch').click();
  await page.getByTestId('probe-z').click();
  await expect(page.getByTestId('probe-error')).toContainText('ALARM:5');
  await expect(page.getByTestId('machine-state')).toHaveText(/Alarm/i);
});

test('surface map: probe a grid and level the loaded job', async ({ page }) => {
  await connectDemo(page);
  await console(page, '$J=G91 X-200 Y-200 F5000', '$J=G91 Z-32 F1000');
  await expect(page.getByTestId('dro-work-Z')).toHaveText('-32.000');
  await page.getByTestId('zero-all').click();
  await expect(page.getByTestId('dro-work-Z')).toHaveText('0.000');
  // Resting on the surface keeps the probe pin on: lift first (the touch test would never pass).
  await console(page, '$J=G91 Z3 F1000');
  await expect(page.getByTestId('dro-work-Z')).toHaveText('3.000');
  await openSample(page, '01-square.nc');
  await expect(page.getByTestId('stat-time')).toBeVisible();
  await page.getByTestId('open-probe').click();
  await page.getByRole('tab', { name: 'Surface map' }).click();
  await page.getByLabel('Points in X').fill('3');
  await page.getByLabel('Points in Y').fill('3');
  await page.getByTestId('simulate-touch').click();
  await page.getByTestId('probe-heightmap').click();
  // 9 points × ~6 steps, each waiting for its reply: slow with software WebGL
  await expect(page.getByTestId('probe-result')).toContainText('measured at 9 points', { timeout: 60_000 });
  await expect(page.getByTestId('heightmap-preview')).toBeVisible();
  await page.getByTestId('apply-leveling').click();
  await expect(page.getByTestId('probe-result')).toContainText('01-square-leveled.nc');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('job-name')).toHaveText('01-square-leveled.nc');
});

test('start from a line shows the recovery and goes to pre-flight', async ({ page }) => {
  await connectDemo(page);
  await openSample(page, '03-pocket.nc');
  await expect(page.getByTestId('stat-time')).toBeVisible();
  await page.getByTestId('start-from-line').click();
  await page.getByTestId('start-line-input').fill('14');
  await page.getByTestId('start-line-preview').click();
  const plan = page.getByTestId('start-line-plan');
  await expect(plan).toContainText('Starts at line 14');
  await expect(plan).toContainText('G53 G0 Z');
  await expect(plan).toContainText('M3 S16000');
  await page.getByTestId('start-line-continue').click();
  await expect(page.getByRole('heading', { name: 'Ready to run from line 14?' })).toBeVisible();
  await expect(page.getByTestId('preflight-list')).toContainText('recovery lines are sent first');
});
