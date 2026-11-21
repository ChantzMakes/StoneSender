/**
 * Performance pass (Phase 8): times every stage the app runs on a big file.
 *   node scripts/gen-stress.mjs 5000000 && npm run perf
 * PERF_FILE overrides the file. Not part of `npm test`.
 */
import fs from 'node:fs';
import { it } from 'vitest';
import { analyze } from '@/lib/gcode/analyze';
import { buildRenderGeometry } from '@/lib/gcode/render';
import { profileFromPreset } from '@/lib/profile/presets';

const file = process.env.PERF_FILE ?? 'samples/gcode/stress.nc';

it('analyses the stress file', () => {
  if (!fs.existsSync(file)) {
    console.log(`no ${file}; run node scripts/gen-stress.mjs first`);
    return;
  }
  const mem = () => `${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB heap, ${(process.memoryUsage().arrayBuffers / 1e6).toFixed(0)} MB buffers`;
  let t = performance.now();
  const text = fs.readFileSync(file, 'utf8');
  const lap = (what: string) => {
    const now = performance.now();
    console.log(`${what.padEnd(22)} ${(now - t).toFixed(0).padStart(6)} ms   ${mem()}`);
    t = now;
  };
  lap(`read ${(text.length / 1e6).toFixed(0)} MB`);
  const profile = profileFromPreset('generic-router');
  let stage = '';
  let stageT = performance.now();
  const r = analyze({ text, profile }, (s) => {
    if (s !== stage) {
      if (stage) console.log(`  ${stage.padEnd(20)} ${(performance.now() - stageT).toFixed(0).padStart(6)} ms`);
      stage = s;
      stageT = performance.now();
    }
  });
  console.log(`  ${stage.padEnd(20)} ${(performance.now() - stageT).toFixed(0).padStart(6)} ms`);
  lap(`analyze ${r.toolpath.count} seg`);
  const g = buildRenderGeometry(r.toolpath, {});
  lap(`render ${(g.positions.length / 3) | 0} vtx`);
  console.log(`time estimate ${r.stats.time.total.toFixed(0)} s, checkpoints ${r.checkpoints.length}`);
}, 600_000);
