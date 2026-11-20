import { expect, type Page } from '@playwright/test';

export async function freshApp(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

export async function runWizard(page: Page, presetId: string, name: string) {
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByTestId('wizard-next').click(); // welcome
  await page.getByTestId(`preset-${presetId}`).click();
  for (let i = 0; i < 7; i++) await page.getByTestId('wizard-next').click();
  await page.getByLabel('Profile name').fill(name);
  await page.getByTestId('wizard-save').click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

export async function connectDemo(page: Page) {
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('machine-state')).toHaveText('Idle');
}
