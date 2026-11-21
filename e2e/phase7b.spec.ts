import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

async function openSample(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-job').click();
  await (await chooser).setFiles(path.resolve('samples/gcode', name));
  await expect(page.getByTestId('job-name')).toHaveText(name);
}

test.describe('router', () => {
  test.beforeEach(async ({ page }) => {
    test.slow();
    await freshApp(page);
    await runWizard(page, 'generic-router', 'Router');
  });

  test('generate a surfacing job, then transform it', async ({ page }) => {
    await page.getByTestId('open-generate').click();
    await page.getByLabel('Total depth').fill('1');
    await page.getByTestId('generate-create').click();
    await expect(page.getByTestId('job-name')).toHaveText('surfacing.nc');
    await expect(page.getByTestId('stat-depth')).toContainText('Z -1.00 mm');

    await page.getByTestId('open-transform').click();
    await page.getByRole('combobox', { name: 'Transform' }).click();
    await page.getByRole('option', { name: 'Rotate' }).click();
    await page.getByTestId('transform-apply').click();
    await expect(page.getByTestId('job-name')).toHaveText('surfacing-rotated.nc');
  });

  test('macros: run with a variable, and import with review', async ({ page }) => {
    await connectDemo(page);
    await expect(page.getByTestId('macro-panel')).toContainText('Raise to safe Z');
    // add a macro with a variable
    await page.getByTestId('macro-edit').click();
    await page.getByTestId('macro-add').click();
    await page.getByLabel('Button label').fill('Go X');
    await page.getByLabel('G-code').fill('G21 G90\nG0 X{x=5}');
    await page.getByTestId('macro-save').click();
    await page.getByTestId('macro-run-Go X').click();
    await page.getByLabel('x', { exact: true }).fill('12');
    await page.getByTestId('macro-run-confirm').click();
    await expect(page.getByTestId('dro-work-X')).toHaveText('12.000');

    // import: shown in full, only ticked ones are added; settings writes can't be ticked
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'macros-')), 'shared.json');
    fs.writeFileSync(file, JSON.stringify({ format: 'cnc-sender-macros', version: 1, macros: [{ name: 'Probe corner', gcode: 'G21\nG0 Z5' }, { name: 'Bad', gcode: '$110=9999' }] }));
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('macro-import').click();
    await (await chooser).setFiles(file);
    await expect(page.getByTestId('macro-review')).toContainText('G0 Z5');
    await expect(page.getByTestId('macro-pick-Bad')).toBeDisabled();
    await page.getByTestId('macro-pick-Probe corner').check();
    await page.getByTestId('macro-import-confirm').click();
    await expect(page.getByTestId('macro-run-Probe corner')).toBeVisible();
    await expect(page.getByTestId('macro-panel')).not.toContainText('Bad');
  });

  test('gamepad jogs only while the enable button is held', async ({ page }) => {
    await page.addInitScript(() => {
      const state = { axes: [0, 0, 0, 0], pressed: new Set<number>() };
      (window as unknown as { __pad: typeof state }).__pad = state;
      navigator.getGamepads = () =>
        [
          {
            id: 'Test pad',
            connected: true,
            index: 0,
            mapping: 'standard',
            timestamp: 0,
            axes: state.axes,
            buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: state.pressed.has(i), touched: false, value: state.pressed.has(i) ? 1 : 0 })),
            hapticActuators: [],
            vibrationActuator: null,
          },
        ] as unknown as Gamepad[];
    });
    await page.reload();
    await connectDemo(page);
    await expect(page.getByTestId('gamepad-status')).toContainText('hold LB');
    // stick pushed right without the enable button: nothing moves
    await page.evaluate(() => ((window as unknown as { __pad: { axes: number[] } }).__pad.axes[0] = 1));
    await page.waitForTimeout(400);
    await expect(page.getByTestId('dro-work-X')).toHaveText('0.000');
    // hold LB: it jogs
    await page.evaluate(() => (window as unknown as { __pad: { pressed: Set<number> } }).__pad.pressed.add(4));
    await expect(page.getByTestId('gamepad-status')).toContainText('jogging');
    await expect.poll(async () => Number(await page.getByTestId('dro-work-X').textContent())).toBeGreaterThan(1);
    // release: it stops
    await page.evaluate(() => (window as unknown as { __pad: { pressed: Set<number> } }).__pad.pressed.delete(4));
    await expect(page.getByTestId('gamepad-status')).toContainText('hold LB');
    // the DRO follows status reports (a few per second): let the last one arrive, then check nothing moves
    await page.waitForTimeout(600);
    const x = await page.getByTestId('dro-work-X').textContent();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('dro-work-X')).toHaveText(x!);
  });
});

test('laser: frame the job', async ({ page }) => {
  test.slow();
  await freshApp(page);
  await runWizard(page, 'generic-laser', 'Laser');
  await connectDemo(page);
  await openSample(page, '04-laser-vector.nc');
  await expect(page.getByTestId('stat-time')).toBeVisible();
  await page.getByTestId('frame-job').click();
  await expect(page.getByTestId('console-log')).toContainText('Framing done.', { timeout: 20_000 });
  await expect(page.getByTestId('console-log')).toContainText('G1 X');
});
