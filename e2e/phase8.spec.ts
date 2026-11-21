import { expect, type Page, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test.beforeEach(async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
});

test('preferences: theme and size persist; layouts show and hide panels', async ({ page }) => {
  await blur(page);
  await page.keyboard.press('Control+Comma');
  const prefs = page.getByTestId('prefs-dialog');
  await expect(prefs).toBeVisible();
  await prefs.getByRole('combobox', { name: 'Theme' }).click();
  await page.getByRole('option', { name: 'High contrast' }).click();
  await prefs.getByRole('radio', { name: '125 %' }).click();
  await expect(page.locator('html')).toHaveClass(/contrast/);
  await expect(page.locator('html')).toHaveCSS('font-size', '20px');

  await prefs.getByRole('tab', { name: 'Layout' }).click();
  await page.getByTestId('layout-running').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jog-x-plus')).toHaveCount(0);
  await expect(page.getByTestId('macro-panel')).toHaveCount(0);
  await expect(page.getByTestId('open-job')).toBeVisible();
  await expect(page.getByTestId('stop-button')).toBeVisible();
  // Ctrl+J brings the console back
  await expect(page.getByPlaceholder(/Connect first|Type a command/)).toHaveCount(0);
  await blur(page);
  await page.keyboard.press('Control+J');
  await expect(page.getByPlaceholder(/Connect first|Type a command/)).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveClass(/contrast/);
  await expect(page.getByTestId('jog-x-plus')).toHaveCount(0);
  await page.getByTestId('open-prefs').click();
  await page.getByRole('tab', { name: 'Layout' }).click();
  await page.getByTestId('layout-standard').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('jog-x-plus')).toBeVisible();
});

test('keyboard jog is off until switched on; keys can be rebound', async ({ page }) => {
  await connectDemo(page);
  await blur(page);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('dro-work-X')).toHaveText('0.000');

  await page.getByTestId('keyboard-jog').click();
  await blur(page);
  await page.keyboard.press('ArrowRight'); // tap = one step
  await expect.poll(async () => Number(await page.getByTestId('dro-work-X').textContent())).toBeGreaterThan(0);
  const x = Number(await page.getByTestId('dro-work-X').textContent());

  // Rebind X+ to D; a taken key is refused with the reason
  await page.getByTestId('open-prefs').click();
  await page.getByTestId('prefs-tab-shortcuts').click();
  await page.getByTestId('shortcut-set-help').click();
  await page.keyboard.press('Control+O');
  await expect(page.getByTestId('shortcut-help')).toContainText('already used');
  await page.getByTestId('shortcut-set-jog.x+').click();
  await page.keyboard.press('d');
  await expect(page.getByTestId('shortcut-set-jog.x+')).toHaveText('D');
  await page.keyboard.press('Escape');
  await blur(page);
  await page.keyboard.press('ArrowRight'); // no longer bound
  await page.waitForTimeout(400);
  await expect(page.getByTestId('dro-work-X')).toHaveText(x.toFixed(3));
  await page.keyboard.press('d');
  await expect.poll(async () => Number(await page.getByTestId('dro-work-X').textContent())).toBeGreaterThan(x);

  // switched off again after a restart
  await page.reload();
  await expect(page.getByTestId('keyboard-jog')).toHaveAttribute('aria-checked', 'false');
});

test('help: F1, search, context sections, shortcuts and codes', async ({ page }) => {
  await blur(page);
  await page.keyboard.press('F1');
  const help = page.getByTestId('help-dialog');
  await expect(help).toBeVisible();
  await page.getByTestId('help-search').fill('tool setter');
  await expect(page.getByTestId('help-body')).toContainText('Probing');
  await expect(page.getByTestId('help-body')).not.toContainText('Sharing profiles');
  await page.getByTestId('help-tab-shortcuts').click();
  await expect(page.getByTestId('help-shortcuts')).toContainText('Open a G-code file');
  await page.getByTestId('help-tab-codes').click();
  await expect(page.getByTestId('help-codes')).toContainText('ALARM:1');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // the "?" next to the Macros panel opens the guide at its section
  await page.getByTestId('help-macros').click();
  await expect(page.getByRole('heading', { name: 'Macros' })).toBeInViewport();
});
