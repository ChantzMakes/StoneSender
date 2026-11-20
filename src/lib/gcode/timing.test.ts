/**
 * Cross-check: the TypeScript planner's estimate vs the Rust emulator actually
 * running each sample job (fixture from `node scripts/gen-timing-fixtures.mjs`).
 * The two are independent implementations of GRBL's motion model.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPreset } from '@/lib/profile/presets';
import { analyze } from './analyze';
import fixtures from './__fixtures__/emulator-times.json';

const root = path.resolve(__dirname, '../../..');

describe('time estimate vs emulator', () => {
  it.each(fixtures.map((f) => [`${path.basename(f.job)} on ${f.preset}`, f] as const))('%s', (_name, f) => {
    const profile = structuredClone(getPreset(f.preset)!.profile);
    const text = readFileSync(path.join(root, f.job), 'utf8');
    const res = analyze({ text, profile, plannerBlocks: f.flavor === 'grblhal' ? 35 : 15 });
    const est = res.stats.time.total;
    const err = Math.abs(est - f.emulatorSeconds) / f.emulatorSeconds;
    expect(err, `estimate ${est.toFixed(2)} s vs emulator ${f.emulatorSeconds} s`).toBeLessThan(0.04);
  });
});
