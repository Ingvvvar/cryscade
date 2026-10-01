import { defineConfig, devices } from '@playwright/test';

// npm run e2e — работает где угодно, GPU не нужен. Визуальные проверки на GPU — playwright.gpu.config.ts (npm run shots).
const PROD = 4173;
const E2E = 4174;
const DEV = 5173;
const url = (port: number): string => `http://localhost:${String(port)}/cryscade/`;

// Полный Chromium (Chrome for Testing), не headless shell: shell не запрашивает /favicon.ico, и пустая консоль
// не поймала бы пропавший favicon. У него же настоящий WebGPU на Metal.
const chrome = { ...devices['Desktop Chrome'], channel: 'chromium' };
// WebKit — весь список §14 (фаза 9). Только Chromium: keyboard.spec — обход кнопок по Tab (WebKit на macOS кнопки по
// Tab не обходит: настройка системы, не свойство игры); frame-clock.spec — контроль дробных дельт кадра (WebKit отдаёт
// время кадра целыми мс); fallback.spec — модель CI (headless shell без WebGPU); bundle.spec — без браузера. Пустая
// консоль — в каждом тесте: tests/support/fixtures.ts.
const safari = devices['Desktop Safari'];
const GAME = ['game', 'resilience', 'storage', 'presentation', 'fairness', 'replay', 'shell', 'dialogs', 'autoplay', 'sound', 'console', 'renders'];
const specs = (names: readonly string[]): RegExp => new RegExp(`/(${names.join('|')})\\.spec\\.ts$`);

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: process.env['CI'] !== undefined,
  reporter: 'list',
  projects: [
    { name: 'smoke', testMatch: 'smoke.spec.ts', use: { ...chrome, baseURL: url(PROD) } },
    { name: 'smoke-webkit', testMatch: 'smoke.spec.ts', use: { ...safari, baseURL: url(PROD) } },
    // Лаборатория сети в прод-сборке (решение 2 фазы 7): зонда нет — только DOM и IndexedDB.
    { name: 'prod-lab', testMatch: 'lab.spec.ts', use: { ...chrome, baseURL: url(PROD) } },
    { name: 'prod-lab-webkit', testMatch: 'lab.spec.ts', use: { ...safari, baseURL: url(PROD) } },
    // StrictMode монтирует дважды только в dev-сборке React; разметка фаз кадра для DevTools — только в dev (§13).
    // WebGPU-вариант StrictMode — в GPU-проекте: WebGPU есть только на настоящем GPU.
    { name: 'strict-mode', testMatch: specs(['strict-mode', 'devtools-marks']), use: { ...chrome, baseURL: url(DEV) } },
    { name: 'strict-mode-webkit', testMatch: specs(['strict-mode', 'devtools-marks']), use: { ...safari, baseURL: url(DEV) } },
    // Headless shell: WebGPU нет, WebGL — SwiftShader. Проверка отката и видимой ошибки принудительного выбора.
    { name: 'fallback', testMatch: 'fallback.spec.ts', use: { ...devices['Desktop Chrome'], baseURL: url(E2E) } },
    { name: 'bundle', testMatch: 'bundle.spec.ts' },
    // Игра на e2e-сборке: зонд видит контроллер и лабораторию сети; вкладки одного профиля делят IndexedDB и замки.
    { name: 'game', testMatch: specs([...GAME, 'keyboard', 'frame-clock']), use: { ...chrome, baseURL: url(E2E) } },
    { name: 'webkit', testMatch: specs(GAME), use: { ...safari, baseURL: url(E2E) } },
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
