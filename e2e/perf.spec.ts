/**
 * Phase 8 performance pass: open the 5M-line stress file and record how long
 * each stage takes and how long the main thread is blocked.
 *
 *   node scripts/gen-stress.mjs 5000000
 *   $env:PERF_E2E=1; npx playwright test perf --workers 1
 *
 * Skipped in the normal suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { freshApp, runWizard } from './helpers';

const file = path.resolve(process.env.PERF_FILE ?? 'samples/gcode/stress.nc');

test.skip(!process.env.PERF_E2E || !fs.existsSync(file), 'set PERF_E2E=1 and generate the stress file');

test('5M-line file: load, analyse, view', async ({ page }) => {
  test.setTimeout(600_000);
  await freshApp(page);
  await runWizard(page, 'generic-router', 'Router');
  await page.evaluate(() => {
    const w = window as unknown as { __long: { start: number; duration: number }[] };
    w.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: false });
  });
  const cdp = process.env.PERF_PROFILE ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const t0 = Date.now();
  const lap = (what: string) => console.log(`${what.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('open-job').click();
  await (await chooser).setFiles(file);
  await expect(page.getByTestId('job-name')).toHaveText(path.basename(file), { timeout: 120_000 });
  lap('file loaded');
  await expect(page.getByTestId('stat-time')).toBeVisible({ timeout: 300_000 });
  lap('analysis done');
  await page.waitForTimeout(5000);
  lap('settled');
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    fs.writeFileSync(process.env.PERF_PROFILE!, JSON.stringify(profile));
  }
  const long = await page.evaluate(() => (window as unknown as { __long: { start: number; duration: number }[] }).__long);
  const total = long.reduce((a, b) => a + b.duration, 0);
  const worst = [...long].sort((a, b) => b.duration - a.duration).slice(0, 8);
  console.log(`main thread: ${long.length} long tasks, ${(total / 1000).toFixed(1)} s blocked in total`);
  for (const w of worst) console.log(`  ${(w.duration / 1000).toFixed(2)} s at ${(w.start / 1000).toFixed(1)} s`);
  const mem = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  console.log(`JS heap (main thread) ${(mem / 1e6).toFixed(0)} MB`);
});
