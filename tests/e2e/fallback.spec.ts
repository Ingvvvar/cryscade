import { expect, test } from '../support/fixtures.ts';
import { BROWSER_ENVIRONMENT, mountCounts, sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';

// Headless shell: адаптера WebGPU нет, WebGL — SwiftShader (проба фазы 3). Так же будет в CI.
// Без параметра — откат на WebGL; принудительный WebGPU — видимая ошибка, а не тихая подмена.
// Здесь же — положительный контроль фильтра консоли (BROWSER_ENVIRONMENT, общий для всех e2e): сообщения среды без GPU
// в этой среде обязаны прийти, и ничего, кроме них: «No available adapters.» — откат сначала спрашивает WebGPU;
// «GPU stall due to ReadPixels» — headless shell читает кадр WebGL на SwiftShader (проверено на голой странице без Pixi).
// И контроль отрисовки при программном рендере: зонд зовёт render Pixi не чаще раза в секунду (e2e в CI без GPU).

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

test('программный рендер: тикер — каждый кадр, отрисовка — не чаще раза в секунду (e2e в CI без GPU)', async ({ page }) => {
  await page.addInitScript(installRenderCounter);
  await page.goto('./');
  await waitSettled(page);
  expect((await sceneInfo(page)).software).toBe(true);
  const idle = await page.evaluate(async () => {
    const counts = (window as Window & { __renderCounts?: { frames: number; renders: number } }).__renderCounts;
    const probe = (window as ProbeWindow).__cryscadeProbe;
    if (counts === undefined || probe === undefined) throw new Error('нет счётчика отрисовок или зонда');
    const renders = counts.renders;
    const at = performance.now();
    probe.startFrames();
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    return { ticks: probe.stopFrames().ms.length, renders: counts.renders - renders, ms: performance.now() - at };
  });
  console.log(`программный рендер, ${idle.ms.toFixed(0)} мс покоя: кадров тикера ${String(idle.ticks)}, отрисовок ${String(idle.renders)}`);
  expect(idle.renders, 'отрисовки есть').toBeGreaterThan(0);
  expect(idle.renders, 'отрисовка — не чаще раза в секунду').toBeLessThanOrEqual(Math.floor(idle.ms / 1000) + 1);
  expect(idle.ticks, 'тикер идёт каждый кадр — чаще отрисовок').toBeGreaterThan(idle.renders * 3);
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
