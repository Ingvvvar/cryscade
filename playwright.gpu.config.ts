import { defineConfig, devices } from '@playwright/test';

// npm run shots — визуальные проверки только на настоящем GPU, локально перед коммитом (§15, фаза 3).
// Вне npm run e2e: в CI GPU нет. Тесты печатают строку рендерера и отказываются считать на программном рендере.
const E2E = 4174;
const DEV = 5173;
const url = (port: number): string => `http://localhost:${String(port)}/cryscade/`;
const chrome = { ...devices['Desktop Chrome'], channel: 'chromium' };

export default defineConfig({
  testDir: 'tests/gpu',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  workers: 1,
  projects: [
    { name: 'gpu', testIgnore: ['strict-mode.spec.ts', 'touch-shots.spec.ts', 'long-press.spec.ts'], use: { ...chrome, baseURL: url(E2E) } },
    // Нажатое каждой кнопки на телефонах и планшетах (прогон №6) — reports/mobile/: Android — Chromium, iPhone и iPad — WebKit.
    // Долгое касание жестом браузера — только здесь: в CI на Linux синтетическое касание :active не даёт.
    { name: 'gpu-touch', testMatch: ['touch-shots.spec.ts', 'long-press.spec.ts'], grep: /Android · /, use: { ...chrome, baseURL: url(E2E) } },
    { name: 'gpu-touch-webkit', testMatch: 'touch-shots.spec.ts', grep: /iOS · /, use: { ...devices['Desktop Safari'], baseURL: url(E2E) } },
    // StrictMode на WebGPU (фаза 9): двойной монтаж — только в dev-сборке React, WebGPU — только на настоящем GPU.
    { name: 'gpu-dev', testMatch: 'strict-mode.spec.ts', use: { ...chrome, baseURL: url(DEV) } },
  ],
  webServer: [
    {
      command: `npm run build:e2e && npx vite preview --outDir dist-e2e --port ${String(E2E)} --strictPort`,
      url: url(E2E),
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${String(DEV)} --strictPort`,
      url: url(DEV),
      reuseExistingServer: false,
    },
  ],
});
