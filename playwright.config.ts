import { defineConfig, devices } from '@playwright/test';

// npm run e2e — работает где угодно, GPU не нужен. Визуальные проверки на GPU — playwright.gpu.config.ts (npm run shots).
const PROD = 4173;
const E2E = 4174;
const DEV = 5173;
const url = (port: number): string => `http://localhost:${String(port)}/cryscade/`;

// Полный Chromium (Chrome for Testing), не headless shell: shell не запрашивает /favicon.ico, и пустая консоль
// не поймала бы пропавший favicon. У него же настоящий WebGPU на Metal.
const chrome = { ...devices['Desktop Chrome'], channel: 'chromium' };

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  projects: [
    { name: 'smoke', testMatch: 'smoke.spec.ts', use: { ...chrome, baseURL: url(PROD) } },
    // StrictMode монтирует дважды только в dev-сборке React.
    { name: 'strict-mode', testMatch: 'strict-mode.spec.ts', use: { ...chrome, baseURL: url(DEV) } },
    // Headless shell: WebGPU нет, WebGL — SwiftShader. Проверка отката и видимой ошибки принудительного выбора.
    { name: 'fallback', testMatch: 'fallback.spec.ts', use: { ...devices['Desktop Chrome'], baseURL: url(E2E) } },
    { name: 'bundle', testMatch: 'bundle.spec.ts' },
    // Игра на e2e-сборке: зонд видит контроллер и лабораторию сети; вкладки одного профиля делят IndexedDB и замки.
    { name: 'game', testMatch: /(game|resilience|storage|presentation|fairness|replay)\.spec\.ts$/, use: { ...chrome, baseURL: url(E2E) } },
    // Повтор в WebKit: события движка JavaScriptCore = литерал из Node (§7, фаза 6).
    { name: 'webkit', testMatch: 'replay.spec.ts', use: { ...devices['Desktop Safari'], baseURL: url(E2E) } },
  ],
  webServer: [
    {
      command: `npm run build && npm run preview -- --port ${String(PROD)} --strictPort`,
      url: url(PROD),
      reuseExistingServer: false,
    },
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
