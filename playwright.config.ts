import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run the frontend in a plain browser (browser backend: profiles in
 * localStorage, a scripted demo controller). The Rust link layer and the
 * virtual GRBL device are covered by `cargo test` integration tests.
 */
export default defineConfig({
  testDir: './e2e',
  // GitHub's runners are slower than a desktop (4 vCPUs shared by the browser, Vite and
  // software WebGL): fewer workers, more time, and one retry for a starved run.
  timeout: process.env.CI ? 60_000 : 30_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  // Software WebGL in headless Chromium is CPU-heavy; too many workers starve each other.
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1420',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
