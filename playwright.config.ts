import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}/cryscade/`,
  },
  // Полный Chromium, не headless shell: shell не запрашивает /favicon.ico,
  // и пустая консоль не поймала бы пропавший favicon.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}/cryscade/`,
    reuseExistingServer: false,
  },
});
