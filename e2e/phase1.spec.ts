import { expect, type Page, test } from '@playwright/test';

async function runWizard(page: Page, presetId: string, name: string) {
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByTestId('wizard-next').click(); // welcome
  await page.getByTestId(`preset-${presetId}`).click();
  await page.getByTestId('wizard-next').click(); // preset
  await page.getByTestId('wizard-next').click(); // type
  await page.getByTestId('wizard-next').click(); // area
  await page.getByTestId('wizard-next').click(); // homing
  await page.getByTestId('wizard-next').click(); // controller
  await page.getByTestId('wizard-next').click(); // tool
  await page.getByTestId('wizard-next').click(); // probe
  const nameInput = page.getByLabel('Profile name');
  await nameInput.fill(name);
  await page.getByTestId('wizard-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('first run opens the setup wizard and creates a profile', async ({ page }) => {
  await runWizard(page, 'desktop-3018', 'Desk mill');
  await expect(page.getByTestId('profile-switcher')).toContainText('Desk mill');
  // The work area view is sized from the 3018 preset (300 × 180 mm)
  await expect(page.getByText('Work area — 300 × 180 mm')).toBeVisible();
});

test('the wizard blocks invalid values', async ({ page }) => {
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await page.getByLabel('Travel X').fill('-5');
  await expect(page.getByRole('alert')).toContainText('Travel X');
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
  await page.getByLabel('Travel X').fill('500');
  await expect(page.getByTestId('wizard-next')).toBeEnabled();
});

test('connect to the simulated controller, see DRO and console, jog', async ({ page }) => {
  await runWizard(page, 'generic-router', 'Router');
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('machine-state')).toHaveText('Idle');
  await expect(page.getByTestId('console-log')).toContainText("Grbl 1.1h ['$' for help]");
  await expect(page.getByTestId('connection-health')).toContainText('healthy');
  await page.getByTestId('console-input').fill('$J=G91 X5 F500');
  await page.getByTestId('console-input').press('Enter');
  await expect(page.getByTestId('dro-work-X')).toHaveText('5.000');
  await expect(page.getByTestId('stop-button')).toBeEnabled();
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('stop-button')).toBeDisabled();
});

test('export then import a profile, with review before adding', async ({ page }) => {
  await runWizard(page, 'shapeoko', 'Shared machine');
  await page.getByTestId('profile-switcher').click();
  await page.getByTestId('manage-profiles').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-profile').click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(download.suggestedFilename()).toBe('shared-machine.cncprofile.json');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-profile').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
  await expect(page.getByText('Review imported profile')).toBeVisible();
  await expect(page.getByText('Shared machine (imported)')).toBeVisible();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText('Shared machine (imported)')).toBeVisible();
});

test('importing a broken file shows errors and adds nothing', async ({ page }) => {
  await runWizard(page, 'generic-laser', 'Laser');
  await page.getByTestId('profile-switcher').click();
  await page.getByTestId('manage-profiles').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-profile').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion": 1, "id": "x"}') });
  await expect(page.getByText("This file can't be imported")).toBeVisible();
  await expect(page.getByTestId('import-confirm')).toHaveCount(0);
});
