import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

async function openSample(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-job').click();
  await (await chooser).setFiles(path.resolve('samples/gcode', name));
  await expect(page.getByTestId('job-name')).toHaveText(name);
}

test.beforeEach(async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
});

test('opening a job shows planner statistics', async ({ page }) => {
  await openSample(page, '01-square.nc');
  await expect(page.getByTestId('job-stats')).toBeVisible();
  await expect(page.getByTestId('stat-time')).toContainText(/\d+:\d\d/);
  await expect(page.getByTestId('stat-depth')).toContainText('Z -1.00 mm');
  await expect(page.getByTestId('job-stats')).toContainText('50.0 × 50.0');
});

test('the G-code tab highlights code, marks errors, and edits can be used', async ({ page }) => {
  await openSample(page, '01-square.nc');
  await page.getByTestId('editor-tab').click();
  const editor = page.getByTestId('gcode-editor');
  await expect(editor.locator('.view-lines')).toContainText('G21 G90 G17 G94');
  await expect(page.locator('.mtk1, .view-line span').first()).toBeVisible();

  // Append an arc whose radius cannot reach its end point (GRBL error 34).
  await editor.locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nG2 X5 Y5 R1');
  await page.getByTestId('use-edited').click();
  await expect(page.getByText(/1 error\(s\)/)).toBeVisible();
  await expect(page.getByTestId('job-stats')).toContainText('1 line(s) the controller will reject');
});

test('pre-flight checks the job against the machine travel from the work zero', async ({ page }) => {
  await connectDemo(page);
  await openSample(page, '01-square.nc');
  await expect(page.getByTestId('stat-time')).toBeVisible();
  // Work zero = machine zero (back-right top corner): the square sticks out past +X/+Y/+Z.
  await page.getByTestId('run-job').click();
  await expect(page.getByTestId('preflight-list')).toContainText('does not fit inside the machine travel');
  await expect(page.getByTestId('preflight-start')).toBeDisabled();
  await page.keyboard.press('Escape');

  // Move to the middle of the bed and 20 mm down, then zero there.
  for (const cmd of ['$J=G91 X-200 Y-200 F5000', '$J=G91 Z-20 F1000']) {
    await page.getByTestId('console-input').fill(cmd);
    await page.getByTestId('console-input').press('Enter');
  }
  await expect(page.getByTestId('dro-work-X')).toHaveText('-200.000');
  await page.getByTestId('zero-all').click();
  await expect(page.getByTestId('dro-work-X')).toHaveText('0.000');
  await page.getByTestId('run-job').click();
  await expect(page.getByTestId('preflight-list')).toContainText('The job fits inside the machine travel');
  await expect(page.getByTestId('preflight-list')).toContainText('Deepest cut');
});

test('dropping a file on the window loads it', async ({ page }) => {
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['G21 G90\nG0 X10 Y10\nG1 Z-2 F100\nG1 X30\n'], 'dropped.nc', { type: 'text/plain' }));
    return d;
  });
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dt });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect(page.getByTestId('job-name')).toHaveText('dropped.nc');
  await expect(page.getByTestId('stat-depth')).toContainText('Z -2.00 mm');
});
