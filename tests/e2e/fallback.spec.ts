import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { waitForState } from '../support/game-page.ts';
import { BROWSER_ENVIRONMENT, mountCounts, sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { force } from '../support/presentation-page.ts';

// Headless shell: адаптера WebGPU нет, WebGL — SwiftShader (проба фазы 3). Так же будет в CI.
// Без параметра — откат на WebGL; принудительный WebGPU — видимая ошибка, а не тихая подмена.
// Здесь же — положительный контроль фильтра консоли (BROWSER_ENVIRONMENT, общий для всех e2e): сообщения среды без GPU
// в этой среде обязаны прийти, и ничего, кроме них: «No available adapters.» — откат сначала спрашивает WebGPU;
// «GPU stall due to ReadPixels» — headless shell читает кадр WebGL на SwiftShader (проверено на голой странице без Pixi).
// Эконом-режим (§10) — на программном рендере, как у игрока без GPU и в CI: фон стоит, разрешение 1×, кадр рисуется,
// только когда изменился (показ, ввод, ресайз, смена состояния); полоса уведомлений — один раз за загрузку. Контроль —
// ?economy=off (флаг зонда): в покое кадры идут — не чаще раза в секунду, это порог зонда для CI без GPU; фон идёт, 2×.

test('без ?renderer= откат на WebGL работает, и программный рендер назван программным', async ({ page }) => {
  const raw: string[] = [];
  page.on('console', (message) => raw.push(`${message.type()}: ${message.text()}`));
  await page.goto('./');
  await waitSettled(page);
  const info = await sceneInfo(page);
  expect(info.name).toBe('webgl');
  expect(info.software).toBe(true);
  expect(info.gpu).toMatch(/swiftshader/i);
  expect(raw.filter((line) => line === 'warning: No available adapters.'), 'контроль: среда без GPU пишет своё').not.toHaveLength(0);
  expect(raw.filter((line) => !BROWSER_ENVIRONMENT.some((pattern) => pattern.test(line))), 'кроме сообщений среды — ничего').toEqual([]);
});

/** Кадры страницы и кадры, где был хоть один gl.clear WebGL2 (отрисовка Pixi): init-скрипт, до скриптов страницы. */
function installRenderCounter(): void {
  const counts = { frames: 0, renders: 0 };
  (window as Window & { __renderCounts?: typeof counts }).__renderCounts = counts;
  const frame = (): void => {
    counts.frames += 1;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  let rendered = -1;
  const proto = (globalThis as { WebGL2RenderingContext?: { prototype: object } }).WebGL2RenderingContext?.prototype;
  const original: unknown = proto === undefined ? undefined : Reflect.get(proto, 'clear');
  if (proto === undefined || typeof original !== 'function') return;
  Reflect.set(proto, 'clear', function (this: unknown, ...args: unknown[]): unknown {
    if (rendered !== counts.frames) {
      rendered = counts.frames;
      counts.renders += 1;
    }
    const result: unknown = Reflect.apply(original, this, args);
    return result;
  });
}

interface FrameWindow {
  readonly ticks: number;
  readonly renders: number;
  readonly ms: number;
}

/** Окно в ms: кадры тикера (зонд) и отрисовки (счётчик gl.clear) за него. */
function measureWindow(page: Page, ms: number): Promise<FrameWindow> {
  return page.evaluate(async (length) => {
    const counts = (window as Window & { __renderCounts?: { frames: number; renders: number } }).__renderCounts;
    const probe = (window as ProbeWindow).__cryscadeProbe;
    if (counts === undefined || probe === undefined) throw new Error('нет счётчика отрисовок или зонда');
    const renders = counts.renders;
    const at = performance.now();
    probe.startFrames();
    await new Promise((resolve) => window.setTimeout(resolve, length));
    return { ticks: probe.stopFrames().ms.length, renders: counts.renders - renders, ms: performance.now() - at };
  }, ms);
}

async function renders(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __renderCounts?: { renders: number } }).__renderCounts?.renders ?? -1);
}

async function ambientSeconds(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.ambientSeconds() ?? null);
}

/** Покой: игра ждёт спина, сетка стоит, отложенный порогом последний кадр показа нарисован (порог — 1 с). */
async function settle(page: Page): Promise<void> {
  await waitForState(page, 'idle');
  await waitSettled(page);
  await page.waitForTimeout(1500);
}

test.describe('эконом-режим без GPU (DPR 2 — чтобы 1× отличалось от плотности экрана)', () => {
  test.use({ deviceScaleFactor: 2 });

  test('в покое за 5 с — не больше двух отрисовок, тикер идёт; ввод, ресайз и показ рисуют; фон стоит; 1×; полоса — один раз за загрузку', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(installRenderCounter);
    await page.goto('./');
    const notice = page.locator('[data-notice="economy"]');
    await expect(notice).toHaveText('Апаратне прискорення недоступне — графіку спрощено');
    await settle(page);
    const info = await sceneInfo(page);
    expect([info.software, info.economy, info.resolution]).toStrictEqual([true, true, 1]);
    const idle = await measureWindow(page, 5000);
    console.log(`эконом-режим, ${idle.ms.toFixed(0)} мс покоя: кадров тикера ${String(idle.ticks)}, отрисовок ${String(idle.renders)}`);
    expect(idle.renders, 'в покое кадры не рисуются').toBeLessThanOrEqual(2);
    expect(idle.ticks, 'тикер и часы показа идут').toBeGreaterThan(100);
    // Фон и декор стоят, как при reduced motion: время декора — момент покоя 12.5 с.
    const still = await ambientSeconds(page);
    await page.waitForTimeout(1000);
    expect([still, await ambientSeconds(page)]).toStrictEqual([12.5, 12.5]);
    // Ввод: тап по сцене в покое показа не меняет — кадр всё равно рисуется.
    const beforeInput = await renders(page);
    await page.mouse.click(640, 360);
    await expect.poll(() => renders(page), { timeout: 3000, message: 'ввод рисует кадр' }).toBeGreaterThan(beforeInput);
    // Ресайз.
    await page.waitForTimeout(1200);
    const beforeResize = await renders(page);
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(() => renders(page), { timeout: 3000, message: 'ресайз рисует кадр' }).toBeGreaterThan(beforeResize);
    await settle(page);
    // Показ: кадр меняется каждый тик — рисуется (с порогом зонда — раз в секунду); после — снова покой.
    await force(page, 'multiplier');
    const beforeShow = await renders(page);
    await page.getByRole('button', { name: 'Спін' }).click();
    await waitForState(page, 'presenting');
    await waitForState(page, 'idle', 30_000);
    const shown = (await renders(page)) - beforeShow;
    console.log(`эконом-режим: показ раунда — ${String(shown)} отрисовок`);
    expect(shown, 'показ рисуется').toBeGreaterThanOrEqual(3);
    await settle(page);
    expect((await measureWindow(page, 3000)).renders, 'после показа — снова покой').toBeLessThanOrEqual(1);
    // Полоса ушла сама и не возвращается после перемонтирования сцены: один раз за загрузку.
    await expect(notice).toHaveCount(0, { timeout: 15_000 });
    await page.evaluate(() => {
      (window as ProbeWindow).__cryscadeProbe?.remount();
    });
    await expect.poll(async () => (await mountCounts(page)).inits).toBe(2);
    await page.waitForTimeout(1000);
    await expect(notice).toHaveCount(0);
  });

  test('контроль ?economy=off: в покое кадры идут — не чаще раза в секунду (порог зонда), фон идёт, разрешение 2×, полосы нет', async ({ page }) => {
    await page.addInitScript(installRenderCounter);
    await page.goto('./?economy=off');
    await settle(page);
    const info = await sceneInfo(page);
    expect([info.software, info.economy, info.resolution]).toStrictEqual([true, false, 2]);
    const idle = await measureWindow(page, 5000);
    console.log(`эконом-режим выключен, ${idle.ms.toFixed(0)} мс покоя: кадров тикера ${String(idle.ticks)}, отрисовок ${String(idle.renders)}`);
    expect(idle.renders, 'кадры в покое идут').toBeGreaterThanOrEqual(4);
    expect(idle.renders, 'не чаще раза в секунду').toBeLessThanOrEqual(Math.floor(idle.ms / 1000) + 1);
    expect(idle.ticks, 'тикер идёт каждый кадр — чаще отрисовок').toBeGreaterThan(idle.renders * 3);
    // Время декора идёт с тикером, но не обязано поспевать за часами: отрисовка 2× без GPU держит поток сотни мс, и Pixi
    // режет следующий кадр до 100 мс (minFPS 10) — в CI за секунду набегало 0.47 с. Проверка — что идёт, а не сколько.
    const before = (await ambientSeconds(page)) ?? Number.NaN;
    await page.waitForTimeout(1000);
    expect((await ambientSeconds(page)) ?? Number.NaN, 'время декора идёт').toBeGreaterThan(before);
    await expect(page.locator('[data-notice="economy"]')).toHaveCount(0);
  });
});

test('?renderer=webgpu без WebGPU — видимая ошибка, канваса нет, отката нет', async ({ page }) => {
  await page.goto('./?renderer=webgpu');
  await expect(page.getByRole('alert')).toContainText('webgpu');
  expect(await page.locator('canvas').count()).toBe(0);
  const counts = await mountCounts(page);
  expect(counts.created).toBe(1);
  expect(counts.inits).toBe(0);
  // Сцены нет — иконок из атласа нет: правила пишут имена символов текстом.
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('button', { name: 'Правила і виплати' }).click();
  const table = page.getByTestId('paytable');
  await expect(table.locator('tbody th')).toHaveText(['Кварц', 'Аметист', 'Цитрин', 'Смарагд', 'Сапфір', 'Рубін', 'Діамант']);
  await expect(page.getByRole('dialog', { name: 'Правила і виплати' }).locator('img')).toHaveCount(0);
});
