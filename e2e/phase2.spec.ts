import path from 'node:path';
import { expect, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

test.beforeEach(async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
  await connectDemo(page);
});

test('click jogs one step, hold jogs continuously', async ({ page }) => {
  await page.getByRole('radio', { name: '10', exact: true }).click();
  await page.getByTestId('jog-x-plus').click();
  await expect(page.getByTestId('dro-work-X')).toHaveText('10.000');
  await expect(page.getByTestId('console-log')).toContainText('$J=G91 G21 X10 F2000');

  const btn = page.getByTestId('jog-y-plus');
  const box = (await btn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  // Let the stop land (the browser demo controller moves in 50 ms ticks).
  await page.waitForTimeout(300);
  const y1 = Number(await page.getByTestId('dro-work-Y').textContent());
  expect(y1).toBeGreaterThan(5);
  await page.waitForTimeout(600);
  const y2 = Number(await page.getByTestId('dro-work-Y').textContent());
  expect(y2).toBeCloseTo(y1, 1);
});

test('zero all sets work coordinates to zero', async ({ page }) => {
  await page.getByTestId('jog-x-plus').click();
  await expect(page.getByTestId('dro-work-X')).toHaveText('1.000');
  await page.getByTestId('zero-all').click();
  await expect(page.getByTestId('dro-work-X')).toHaveText('0.000');
});

test('controller errors are explained in the console', async ({ page }) => {
  await page.getByTestId('console-input').fill('M6 T2');
  await page.getByTestId('console-input').press('Enter');
  await expect(page.getByTestId('console-log')).toContainText('error:20 — Unsupported command');
});

test('settings editor: compare, write with per-change confirmation, sync back to profile', async ({ page }) => {
  await page.getByTestId('open-settings').click();
  await page.getByTestId('compare-tab').click();
  await expect(page.getByTestId('diff-summary')).toHaveText('The controller matches the profile.');

  await page.getByRole('tab', { name: 'Controller ($$)' }).click();
  await page.getByLabel('$110 X max rate').fill('1234');
  await page.getByTestId('write-settings').click();
  await expect(page.getByTestId('write-confirm')).toBeDisabled(); // nothing ticked yet
  await page.getByTestId('write-confirm-list').getByRole('checkbox').check();
  await page.getByTestId('write-confirm').click();

  await page.getByTestId('compare-tab').click();
  await expect(page.getByTestId('diff-summary')).toContainText('1 difference(s)');
  await page.getByTestId('copy-to-profile').click();
  await page.getByTestId('confirm-copy-to-profile').click();
  await expect(page.getByTestId('diff-summary')).toHaveText('The controller matches the profile.');
});

test('invalid setting values cannot be written', async ({ page }) => {
  await page.getByTestId('open-settings').click();
  await page.getByLabel('$32 Laser mode').fill('2');
  await expect(page.getByText('must be 0 or 1')).toBeVisible();
  await expect(page.getByTestId('write-settings')).toBeDisabled();
});

test('a job opens with a pre-flight check that must be acknowledged', async ({ page }) => {
  // Put the work zero mid-bed so the job fits inside the travel (Phase 3 travel check).
  for (const cmd of ['$J=G91 X-200 Y-200 F5000', '$J=G91 Z-20 F1000']) {
    await page.getByTestId('console-input').fill(cmd);
    await page.getByTestId('console-input').press('Enter');
  }
  await expect(page.getByTestId('dro-work-Z')).toHaveText('-20.000');
  await page.getByTestId('zero-all').click();
  await expect(page.getByTestId('dro-work-X')).toHaveText('0.000');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-job').click();
  await (await chooser).setFiles(path.resolve('samples/gcode/01-square.nc'));
  await expect(page.getByTestId('job-name')).toHaveText('01-square.nc');
  await page.getByTestId('run-job').click();
  await expect(page.getByTestId('preflight-list')).toContainText('Machine is idle');
  await expect(page.getByTestId('preflight-list')).toContainText('Units: millimetres');
  await expect(page.getByTestId('preflight-start')).toBeDisabled();
  await page.getByTestId('preflight-ack').check();
  await expect(page.getByTestId('preflight-start')).toBeEnabled();
});
