import { defineConfig, devices } from '@playwright/test';

// npm run shots — визуальные проверки только на настоящем GPU, локально перед коммитом (§15, фаза 3).
// Вне npm run e2e: в CI GPU нет. Тесты печатают строку рендерера и отказываются считать на программном рендере.
const E2E = 4174;
const url = `http://localhost:${String(E2E)}/cryscade/`;

export default defineConfig({
  testDir: 'tests/gpu',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  workers: 1,
  projects: [{ name: 'gpu', use: { ...devices['Desktop Chrome'], channel: 'chromium', baseURL: url } }],
  webServer: {
    command: `npm run build:e2e && npx vite preview --outDir dist-e2e --port ${String(E2E)} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
