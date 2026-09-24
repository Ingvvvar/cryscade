import { expect, test } from '@playwright/test';

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
  expect(consoleMessages).toEqual([]);
});
