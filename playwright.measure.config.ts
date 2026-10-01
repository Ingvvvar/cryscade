import { defineConfig, devices } from '@playwright/test';

// npm run measure — замеры §13 (фаза 9): время кадра изнутри кадра и память за 300 спинов. Только на настоящем GPU,
// локально: вне npm run e2e и вне CI (GPU там нет). Тесты печатают строку рендерера и отказываются мерить программный
// рендер. Числа — в reports/phase-9/*.json, таблица — tools/measure/report.ts → reports/phase-9/measure.md.
const E2E = 4174;
const url = `http://localhost:${String(E2E)}/cryscade/`;

export default defineConfig({
  testDir: 'tests/measure',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  workers: 1,
  projects: [{ name: 'measure', use: { ...devices['Desktop Chrome'], channel: 'chromium', baseURL: url } }],
  webServer: {
    command: `npm run build:e2e && npx vite preview --outDir dist-e2e --port ${String(E2E)} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
