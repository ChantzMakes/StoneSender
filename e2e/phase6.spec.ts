import { expect, type Page, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

async function dropJob(page: Page, name: string, text: string) {
  const dt = await page.evaluateHandle(
    ([n, t]) => {
      const d = new DataTransfer();
      d.items.add(new File([t], n, { type: 'text/plain' }));
      return d;
    },
    [name, text] as const,
  );
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dt });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect(page.getByTestId('job-name')).toHaveText(name);
}

const SLOT = 'G21 G90\nT1\nM3 S12000\nG0 Z5\nG0 X10 Y10\nG1 Z-2 F200\nG1 X60 F800\nG0 Z5\nM5\n';

test.describe('router', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
    await runWizard(page, 'generic-router', 'Router');
  });

  test('simulates removal, shows the final result and exports an STL', async ({ page }) => {
    await dropJob(page, 'slot.nc', SLOT);
    const status = page.getByTestId('removal-status');
    await expect(status).toContainText('Material removal');
    await expect(page.getByTestId('removal-ok')).toBeVisible();
    await expect(status).toContainText('follows playback');
    await page.getByTestId('view-result').click();
    await expect(status).toContainText('final result');
    await expect(status).toContainText('deepest Z -2.00');

    const download = page.waitForEvent('download');
    await page.getByTestId('removal-export').click();
    const d = await download;
    expect(d.suggestedFilename()).toBe('slot-result.stl');
    const path = await d.path();
    const fs = await import('node:fs');
    const bytes = fs.readFileSync(path);
    const tris = bytes.readUInt32LE(80);
    expect(tris).toBeGreaterThan(1000);
    expect(bytes.length).toBe(84 + tris * 50);

    // Toggling the simulation off hides its panel.
    await page.getByTestId('toggle-removal').click();
    await expect(status).toHaveCount(0);
  });

  test('flags a rapid through uncut stock in the view and in pre-flight', async ({ page }) => {
    await connectDemo(page);
    await dropJob(page, 'gouge.nc', 'G21 G90\nM3 S12000\nG4 P3\nG0 Z5\nG0 X10 Y10\nG1 Z-3 F200\nG0 X80\nG0 Z5\nM5\n');
    await expect(page.getByTestId('removal-problem-rapid-gouge')).toContainText('first at line 7');
    await page.getByTestId('run-job').click();
    await expect(page.getByTestId('preflight-list')).toContainText('Rapid moves cut material (lines 7)');
  });

  test('tool library: add a tool and assign it to the job', async ({ page }) => {
    await dropJob(page, 'slot.nc', SLOT);
    await expect(page.getByTestId('removal-ok')).toBeVisible();
    await page.getByTestId('stock-settings').click();
    await page.getByTestId('open-tool-library').click();
    await page.getByTestId('tool-add').click();
    await page.getByLabel('Name').fill('2 mm flat');
    await page.getByLabel('Diameter').fill('2');
    await page.getByTestId('tool-save').click();
    await expect(page.getByTestId('tool-list')).toHaveCount(0);

    await page.getByRole('combobox', { name: 'Tool for T1' }).click();
    await page.getByRole('option', { name: /2 mm flat/ }).click();
    await page.getByTestId('stock-save').click();
    // The new assignment re-runs the simulation with the 2 mm tool.
    await expect(page.getByTestId('removal-ok')).toBeVisible();
    await page.getByTestId('stock-settings').click();
    await expect(page.getByRole('combobox', { name: 'Tool for T1' })).toContainText('2 mm flat');
    await page.keyboard.press('Escape');

    // The library is saved with the app settings.
    await page.reload();
    await dropJob(page, 'slot.nc', SLOT);
    await page.getByTestId('stock-settings').click();
    await page.getByTestId('open-tool-library').click();
    await expect(page.getByTestId('tool-list')).toContainText('2 mm flat');
  });
});

test('laser: burn simulation exports a PNG', async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-laser', 'Laser');
  await dropJob(page, 'burn.nc', 'G21 G90\nM4 S0\nG0 X5 Y5\nG1 X40 S800 F1500\nG0 Y6\nG1 X5 S800\nM5\n');
  await expect(page.getByTestId('removal-status')).toContainText('Burn simulation');
  const download = page.waitForEvent('download');
  await page.getByTestId('removal-export').click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('burn-burn.png');
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(await d.path());
  expect([...bytes.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
});
