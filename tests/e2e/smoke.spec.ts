import type { Page, Route } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { BROWSER_ENVIRONMENT } from '../support/page-probe.ts';

/** Медленная сеть для одного чанка: ответ — через 3.5 с, позже окна, после которого WebKit пишет о брошенных preload. */
async function slow(route: Route): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await route.continue();
}

/**
 * Preload, который поставил скрипт, — сверх тех, что отданы в index.html (их страница берёт до load). Отданных больше
 * нуля: иначе сверять не с чем.
 */
async function scriptPreloads(page: Page): Promise<{ readonly shipped: number; readonly added: string[] }> {
  return page.evaluate(async () => {
    const html = await (await fetch(location.href)).text();
    const shipped = new Set([...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => new URL(match[1] ?? '', location.href).href));
    const added = [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"], link[rel="preload"]')].map((link) => link.href).filter((href) => !shipped.has(href));
    return { shipped: shipped.size, added };
  });
}

/** Дождаться, пока пройдёт окно WebKit (3 с после load) с запасом: предупреждение о preload приходит в его конце. */
async function pastPreloadWindow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => performance.now() - ((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.loadEventEnd ?? 0)), { timeout: 15_000 })
    .toBeGreaterThan(5000);
}

test('страница открывается: консоль пуста, запросы только к своему origin, шрифты загружены', async ({ page, baseURL }) => {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const requests: string[] = [];
  const failures: string[] = [];
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  page.on('requestfailed', (request) => failures.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${String(response.status())} ${response.url()}`);
  });

  await page.goto('./', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cryscade');

  // Пока шрифты не загружены, проверки консоли и origin могут закончиться раньше их запросов.
  const loadedFamilies = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family);
  });
  expect(loadedFamilies).toContain('Unbounded Variable');
  expect(loadedFamilies).toContain('Manrope Variable');

  const origin = new URL(baseURL ?? '').origin;
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => !url.startsWith('data:') && new URL(url).origin !== origin)).toEqual([]);
  expect(failures).toEqual([]);
  expect(pageErrors).toEqual([]);
  // Без GPU (CI) браузер пишет свои сообщения среды — их и только их терпит общий фильтр e2e (§15, фаза 9).
  expect(consoleMessages.filter((line) => !BROWSER_ENVIRONMENT.some((pattern) => pattern.test(line)))).toEqual([]);
});

// Прогон №7: WebKit писал в консоль живого адреса «… was preloaded using link preload but not used within a few seconds
// from the window's load event». Помощник Vite ставил preload на зависимости ленивого чанка (format и modal у диалога,
// init у browserAll Pixi), а модуль просит их только после самого чанка: пришёл чанк позже 3 с после load — preload
// «брошен». Теперь динамический импорт preload не ставит. Сеть здесь медленная нарочно; консоль сверяет общая фикстура
// (WebKit), ссылки — сам тест (оба движка: Chromium о брошенных preload не пишет).

test('диалог, открытый сразу после загрузки, на медленной сети не ставит preload и не оставляет сообщений в консоли', async ({ page }) => {
  await page.route(/\/assets\/rules-dialog-[^/]*\.js$/, slow);
  await page.goto('./', { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Правила і виплати' }).click();
  await expect(page.getByRole('dialog', { name: 'Правила і виплати' })).toBeVisible({ timeout: 15_000 });
  await pastPreloadWindow(page);
  const preloads = await scriptPreloads(page);
  expect(preloads.shipped, 'preload в index.html').toBeGreaterThan(0);
  expect(preloads.added, 'preload от скрипта').toStrictEqual([]);
});

test('старт Pixi на медленной сети не ставит preload и не оставляет сообщений в консоли', async ({ page }) => {
  await page.route(/\/assets\/browserAll-[^/]*\.js$/, slow);
  await page.goto('./', { waitUntil: 'load' });
  await expect(page.getByRole('button', { name: 'Спін', exact: true })).toBeVisible({ timeout: 15_000 });
  await pastPreloadWindow(page);
  const preloads = await scriptPreloads(page);
  expect(preloads.shipped, 'preload в index.html').toBeGreaterThan(0);
  expect(preloads.added, 'preload от скрипта').toStrictEqual([]);
});
