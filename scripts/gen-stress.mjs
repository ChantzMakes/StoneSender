#!/usr/bin/env node
/**
 * Generate a large G-code file for performance testing.
 *
 *   node scripts/gen-stress.mjs [lines=5000000] [out=samples/gcode/stress.nc]
 *
 * Produces a spiral-ish raster of short G1 moves with occasional arcs, so the
 * parser, planner and renderer all get exercised. Output is not committed.
 */
import { createWriteStream } from 'node:fs';

const lines = Number(process.argv[2] ?? 5_000_000);
const out = process.argv[3] ?? 'samples/gcode/stress.nc';
const w = createWriteStream(out);
let written = 0;

function write(s) {
  if (!w.write(s + '\n')) return new Promise((r) => w.once('drain', r));
  return null;
}

const header = ['( stress test — generated, do not run on a machine )', 'G21 G90 G17 G94', 'M3 S10000', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-0.2 F600'];
for (const h of header) await write(h);
written += header.length;

let x = 0;
let y = 0;
let dir = 1;
const step = 0.05;
const width = 200;
while (written < lines - 3) {
  if (written % 997 === 0) {
    const p = write(`G2 X${(x + 2).toFixed(3)} Y${y.toFixed(3)} I1 J0 F2000`);
    if (p) await p;
    x += 2;
  } else {
    x += dir * step * 20;
    if (x > width || x < 0) {
      dir = -dir;
      y += step * 4;
      x = Math.max(0, Math.min(width, x));
    }
    const z = -0.2 - 0.1 * Math.sin(x / 10) * Math.cos(y / 10);
    const p = write(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)} F2400`);
    if (p) await p;
  }
  written++;
}
for (const t of ['G0 Z5', 'M5', 'M30']) await write(t);
w.end(() => console.log(`wrote ${written + 3} lines to ${out}`));
