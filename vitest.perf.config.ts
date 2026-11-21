import { defineConfig } from 'vitest/config';
import base from './vite.config';

// Own config (not mergeConfig, which would append the unit-test globs).
export default defineConfig({ ...base, test: { include: ['scripts/perf/**/*.perf.ts'], environment: 'node', testTimeout: 600_000 } });
