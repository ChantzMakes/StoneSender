import { expect, test } from '@playwright/test';
import { connectDemo, freshApp, runWizard } from './helpers';

test.beforeEach(async ({ page }) => {
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
});

test('custom jog step: typed distance moves exactly that far; too-large or invalid steps are not sent', async ({ page }) => {
  await connectDemo(page);
  const custom = page.getByTestId('jog-custom-step');
  await custom.fill('2.5');
  await expect(custom).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('jog-x-plus').click();
  await expect(page.getByTestId('dro-work-X')).toHaveText('2.500');

  // a preset deselects the custom step
  await page.getByRole('radio', { name: '10', exact: true }).click();
  await expect(custom).toHaveAttribute('aria-checked', 'false');
  await custom.focus(); // focusing a valid custom value selects it again
  await expect(custom).toHaveAttribute('aria-checked', 'true');

  // larger than the Z travel: refused, nothing moves
  await custom.fill('5000');
  await page.getByTestId('jog-z-minus').click();
  await expect(page.getByTestId('console-log')).toContainText('larger than the Z travel');
  await expect(page.getByTestId('dro-work-Z')).toHaveText('0.000');

  // not a number: error shown, the previous step is kept
  await custom.fill('abc');
  await expect(page.getByTestId('jog-custom-error')).toBeVisible();
});

test('pop-out status window mirrors the machine state and says when it is stale', async ({ page, context }) => {
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('open-status-window').click();
  const popup = await popupPromise;
  await expect(popup.getByTestId('status-window')).toBeVisible();
  await expect(popup.getByTestId('status-state')).toHaveText('Offline');
  await expect(popup.getByTestId('status-no-job')).toHaveText('Not connected to a machine.');

  await connectDemo(page);
  await expect(popup.getByTestId('status-state')).toHaveText('Idle');
  await expect(popup.getByTestId('status-no-job')).toHaveText('No job running.');
  await expect(popup.getByTestId('status-stale')).toHaveCount(0);

  // the pop-out has nothing that can reach the machine
  await expect(popup.getByRole('button')).toHaveCount(0);

  // main window gone → the pop-out says its values may be out of date
  await page.close();
  await expect(popup.getByTestId('status-stale')).toBeVisible({ timeout: 5000 });
});
