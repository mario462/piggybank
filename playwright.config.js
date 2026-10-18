import { defineConfig, devices } from '@playwright/test';

// Runs the real app + API locally (wrangler pages dev with a throwaway D1 database)
// on an iPhone 13-sized Chromium.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8788',
    ...devices['iPhone 13'],
    browserName: 'chromium',
    defaultBrowserType: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'rm -rf .wrangler/e2e && npx wrangler pages dev public --port 8788 --d1 DB --persist-to .wrangler/e2e --binding DEV_NO_AUTH=1 --compatibility-date 2024-11-01',
    url: 'http://localhost:8788',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
