import { expect, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

async function dropJob(page: import('@playwright/test').Page, name: string, text: string) {
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

test.beforeEach(async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
});

test('the machine model and stock can be toggled; stock settings drive the checks', async ({ page }) => {
  // Cuts 10 mm deep: fine in the default 19 mm stock.
  await dropJob(page, 'deep.nc', 'G21 G90\nG0 Z5\nG0 X10 Y10\nG1 Z-10 F200\nG1 X50\nG0 Z5\n');
  await expect(page.getByTestId('viewer-info')).toContainText('segments');
  await expect(page.getByTestId('sim-problems')).toHaveCount(0);
  await page.getByTestId('toggle-machine').click();
  await page.getByTestId('toggle-machine').click();

  // Make the stock 6 mm thick: now the job cuts 4 mm below it.
  await page.getByTestId('stock-settings').click();
  await page.getByLabel('Thickness (Z)').fill('6');
  await page.getByTestId('stock-save').click();
  await expect(page.getByTestId('sim-problems')).toContainText('Cuts 4.00 mm below the stock from line 4');
});

test('rapids through the stock are flagged in the view and in pre-flight', async ({ page }) => {
  await connectDemo(page);
  for (const cmd of ['$J=G91 X-300 Y-300 F5000', '$J=G91 Z-50 F1000']) {
    await page.getByTestId('console-input').fill(cmd);
    await page.getByTestId('console-input').press('Enter');
  }
  await expect(page.getByTestId('dro-work-Z')).toHaveText('-50.000');
  await page.getByTestId('zero-all').click();
  await expect(page.getByTestId('dro-work-Z')).toHaveText('0.000');
  await dropJob(page, 'rapid.nc', 'G21 G90\nM3 S12000\nG4 P3\nG0 Z5\nG0 X10 Y10\nG1 Z-3 F200\nG0 X80\nG0 Z5\nM5\n');
  await expect(page.getByTestId('sim-problems')).toContainText('1 rapid move(s) through the stock, first at line 7');
  await page.getByTestId('run-job').click();
  await expect(page.getByTestId('preflight-list')).toContainText('1 rapid move(s) pass through the stock');
  await expect(page.getByTestId('preflight-list')).toContainText('Checked against stock');
});
