import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { freshApp, runWizard } from './helpers';

async function openSample(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-job').click();
  await (await chooser).setFiles(path.resolve('samples/gcode', name));
  await expect(page.getByTestId('job-name')).toHaveText(name);
}

const seconds = (s: string) => {
  const [cur] = s.split(' / ');
  const [m, sec] = cur!.split(':').map(Number);
  return m! * 60 + sec!;
};

test.beforeEach(async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
  await openSample(page, '02-arcs-all-planes.nc');
  await expect(page.getByTestId('viewer-info')).toContainText('segments');
});

test('the 3D view renders the toolpath with a WebGL canvas', async ({ page }) => {
  await expect(page.getByTestId('viewer').locator('canvas')).toBeVisible();
  for (const v of ['top', 'front', 'side', 'iso', 'fit']) await page.getByTestId(`view-${v}`).click();
  await page.getByLabel('Colour mode').click();
  await page.getByRole('option', { name: 'Colour: depth (Z)' }).click();
  await expect(page.getByTestId('viewer-info')).toContainText('mm');
});

test('scrubbing and playback move through the job', async ({ page }) => {
  const slider = page.getByTestId('scrub-slider');
  await slider.evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, String(Number(el.max) / 2));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const mid = seconds((await page.getByTestId('scrub-time').textContent())!);
  expect(mid).toBeGreaterThan(0);
  await expect(page.getByTestId('scrubber')).toContainText(/L\d+/);

  await page.getByLabel('Playback speed').click();
  await page.getByRole('option', { name: '100×' }).click();
  await page.getByTestId('play-button').click();
  await page.waitForTimeout(400);
  const later = seconds((await page.getByTestId('scrub-time').textContent())!);
  expect(later).toBeGreaterThan(mid);
});

test('clicking a line in the editor moves playback there', async ({ page }) => {
  await page.getByTestId('editor-tab').click();
  // Monaco only renders visible lines: click into it, then jump to the last line (36: empty, after M30).
  await page.getByTestId('gcode-editor').locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.getByRole('tab', { name: '3D view' }).click();
  await expect(page.getByTestId('scrubber')).toContainText('L36');
  // …which is the end of the job.
  const [cur, total] = (await page.getByTestId('scrub-time').textContent())!.split(' / ');
  expect(cur).toBe(total);
});

test('the measuring tool shows the distance between two clicked points', async ({ page }) => {
  await page.getByTestId('view-top').click();
  await page.getByTestId('toggle-measure').click();
  const canvas = page.getByTestId('viewer').locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.5);
  await expect(page.getByTestId('measure-label')).toBeVisible();
  await expect(page.getByTestId('measure-label')).toContainText(/\d+\.\d\d mm/);
});
