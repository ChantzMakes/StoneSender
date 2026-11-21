/**
 * Phase 8 performance pass, desktop app: loads a file through the real Tauri
 * backend and times it. Start the app (release build for real numbers) with a
 * WebView2 debugging port and a machine profile set up:
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'; npx tauri dev --release
 *   node scripts/perf/desktop-load.mjs [file]
 */
import path from 'node:path';
import { chromium } from '@playwright/test';

const file = path.resolve(process.argv[2] ?? 'samples/gcode/stress.nc');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages()[0];
page.on('crash', () => console.log('the page crashed'));
try {
  const r = await page.evaluate(async (file) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    // raw IPC both ways (generators / transforms upload; file load downloads)
    const up = await invoke('job_load_text', new TextEncoder().encode('G21\nG0 X1\n'), { headers: { name: encodeURIComponent('ré.nc') } });
    const down = new TextDecoder().decode(await invoke('job_source_bytes'));
    if (up.name !== 'ré.nc' || down !== 'G21\nG0 X1\n') throw new Error('raw IPC round trip failed');
    // Same module instances as the app (Vite serves one copy per URL).
    const { useLink } = await import('/src/store/link.ts');
    const { useAnalysis } = await import('/src/store/analysis.ts');
    let longest = 0;
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (longest = Math.max(longest, e.duration)))).observe({ type: 'longtask' });
    const t0 = performance.now();
    await useLink.getState().loadJobPath(file);
    const loaded = (performance.now() - t0) / 1000;
    for (;;) {
      const s = useAnalysis.getState();
      if (s.status === 'error') throw new Error(s.error);
      if (s.status === 'done' && s.result?.sourceLines === useLink.getState().loadedJob.scan.sourceLines) break;
      if (performance.now() - t0 > 300000) throw new Error('analysis timed out');
      await new Promise((res) => setTimeout(res, 100));
    }
    const analysed = (performance.now() - t0) / 1000;
    await new Promise((res) => setTimeout(res, 3000));
    return { lines: useLink.getState().loadedJob.scan.lines, loadedSeconds: loaded.toFixed(1), analysedSeconds: analysed.toFixed(1), longestMainThreadBlockSeconds: (longest / 1000).toFixed(2) };
  }, file);
  console.log(r);
} catch (e) {
  console.log('failed:', e.message);
  process.exitCode = 1;
}
process.exit();
