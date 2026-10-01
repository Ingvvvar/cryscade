import { defineConfig, devices } from '@playwright/test';

// npm run sound:leaks — замер утечек звука (§12, решение 6 фазы 8): две минуты живой игры на e2e-сборке, вне обычного
// e2e (долго). Положительный контроль — ?soundleak=1 (только dev и e2e): источник без stop на каждый сигнал.
const E2E = 4174;
const url = `http://localhost:${String(E2E)}/cryscade/`;

export default defineConfig({
  testDir: 'tests/sound',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  workers: 1,
  projects: [{ name: 'sound', use: { ...devices['Desktop Chrome'], channel: 'chromium', baseURL: url } }],
  webServer: {
    command: `npm run build:e2e && npx vite preview --outDir dist-e2e --port ${String(E2E)} --strictPort`,
    url,
    reuseExistingServer: false,
  },
});
