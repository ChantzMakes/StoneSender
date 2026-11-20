#!/usr/bin/env node
/**
 * Run each sample job through the Rust GRBL emulator and record how long the
 * virtual machine took. `src/lib/gcode/timing.test.ts` compares the planner's
 * estimate against these numbers.
 *
 *   node scripts/gen-timing-fixtures.mjs
 *
 * Re-run after changing the emulator's motion model or the samples.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CASES = [
  { job: 'samples/gcode/01-square.nc', preset: 'generic-router' },
  { job: 'samples/gcode/02-arcs-all-planes.nc', preset: 'generic-router' },
  { job: 'samples/gcode/03-pocket.nc', preset: 'generic-router' },
  { job: 'samples/gcode/04-laser-vector.nc', preset: 'generic-laser' },
  { job: 'samples/gcode/05-laser-raster.nc', preset: 'generic-laser' },
  { job: 'samples/gcode/06-rotary-a-axis.nc', preset: 'generic-rotary', flavor: 'grblhal' },
  { job: 'samples/gcode/07-3d-contour.nc', preset: 'generic-router' },
  { job: 'samples/gcode/01-square.nc', preset: 'desktop-3018' },
  { job: 'samples/gcode/03-pocket.nc', preset: 'shapeoko' },
];

execFileSync('cargo', ['build', '-q', '-p', 'virtual-grbl', '--example', 'time_job', '--release'], { stdio: 'inherit' });
const out = [];
for (const c of CASES) {
  const args = ['run', '-q', '-p', 'virtual-grbl', '--example', 'time_job', '--release', '--', `presets/${c.preset}.json`, c.job, c.flavor ?? 'grbl11'];
  const res = JSON.parse(execFileSync('cargo', args, { encoding: 'utf8' }).trim());
  out.push({ ...c, emulatorSeconds: res.seconds, lines: res.lines });
  console.log(`${c.job} on ${c.preset}: ${res.seconds}s`);
}
writeFileSync('src/lib/gcode/__fixtures__/emulator-times.json', JSON.stringify(out, null, 2) + '\n');
