import { expect, test } from '../support/fixtures.ts';
import { sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { mountsOnce, remountsLive } from '../support/strict-mode.ts';

// Настоящий StrictMode — dev-сборка React (§10): эффект монтируется дважды, а init рендерера асинхронный. Здесь — WebGL
// (Chromium и WebKit, и в CI без GPU); вариант WebGPU — в GPU-проекте (tests/gpu/strict-mode.spec.ts): WebGPU есть
// только на настоящем GPU.

test('webgl: монтирований 2, рендерер один, канвас один, консоль без предупреждений', async ({ page }) => {
  await mountsOnce(page, 'webgl');
});

test('webgl: перемонтирование живой сцены — новый канвас, новый init проходит, консоль чистая', async ({ page }) => {
  await remountsLive(page, 'webgl');
});

test('ресайз портрет → ландшафт: сцена переставлена, канвас тот же', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./?renderer=webgl');
  await waitSettled(page);
  await page.locator('canvas').evaluate((canvas) => {
    canvas.dataset['mark'] = 'first';
  });
  const orientation = (): Promise<string | null> => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.layout()?.orientation ?? null);
  expect(await orientation()).toBe('portrait');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(orientation).toBe('landscape');
  expect(await page.locator('canvas[data-mark="first"]').count()).toBe(1);
  expect(await page.locator('canvas').count()).toBe(1);
  const size = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => ({ css: canvas.getBoundingClientRect().width, px: canvas.width }));
  expect(size.css).toBe(1280);
});

// Перенос окна между мониторами (смена DPR без смены CSS-размера) держит юнит-тест на подставном matchMedia
// (tests/unit/ui/viewport-watcher.test.ts): эмуляция DPR через CDP меняет devicePixelRatio, но change у
// matchMedia('(resolution: …)') не присылает — проверено на голой странице, путь так не доказать.
test.describe('DPR телефона 3', () => {
  test.use({ deviceScaleFactor: 3, viewport: { width: 390, height: 844 } });

  test('разрешение рендерера — 2: атлас выпечен в 2×, лишние пиксели шейдеру не нужны', async ({ page }) => {
    await page.goto('./?renderer=webgl');
    await waitSettled(page);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(3);
    expect((await sceneInfo(page)).resolution).toBe(2);
    expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toStrictEqual([780, 1688]);
  });
});
