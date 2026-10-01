import { expect, test, type Page } from '@playwright/test';
import { sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { DRAW_BUDGET, DRAW_CEILING } from './support/draw-ceilings.ts';
import { installDrawCounter, type DrawCounts } from './support/draw-counter.ts';
import { PINNED_AMBIENT_S } from './support/frame.ts';
import { writeMeasure } from './support/phase9.ts';

// Draw-call в покое: потолок-храповик DRAW_CEILING.rest на обоих рендерерах, бюджет §13 (WebGL ≤ 15) — внешняя граница.
// Кадр — один app.render() при остановленном тикере; счёт — на границе API, с первой отрисовки.
// Сначала положительный контроль: батч рвётся на maxBatchableTextures разных текстур, поэтому 3 × max разных
// текстур обязаны поднять счёт хотя бы на 2; те же 3 × max спрайтов из атласа — не больше чем на 1.

type CountWindow = ProbeWindow & { __drawCounts?: DrawCounts };

async function frameDraws(page: Page): Promise<DrawCounts> {
  return page.evaluate(() => {
    const w = window as CountWindow;
    const counts = w.__drawCounts;
    if (counts === undefined) throw new Error('счётчик draw-call не установлен');
    counts.gl = 0;
    counts.gpu = 0;
    counts.executeBundles = 0;
    w.__cryscadeProbe?.renderOnce();
    return { ...counts };
  });
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  test(`${renderer}: счётчик ловит контроль, потом — draw-call в покое`, async ({ page }) => {
    await page.addInitScript(installDrawCounter);
    await page.goto(`./?renderer=${renderer}`);
    await waitSettled(page);
    const info = await sceneInfo(page);
    expect(info.name).toBe(renderer);
    expect(info.software, `на программном рендере не мерим: ${info.gpu}`).toBe(false);
    // Худший покой: декор закреплён на моменте, когда аддитивный блик рамки виден.
    await page.evaluate((seconds) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      probe?.stopTicker();
      probe?.pinAmbient(seconds);
    }, PINNED_AMBIENT_S);
    const draws = async (): Promise<number> => {
      const counts = await frameDraws(page);
      expect(counts.executeBundles, 'бандлы рендера: счёт был бы неполным').toBe(0);
      return renderer === 'webgl' ? counts.gl : counts.gpu;
    };
    const control = 3 * info.maxBatchableTextures;

    const idle = await draws();
    await page.evaluate((n) => (window as ProbeWindow).__cryscadeProbe?.addControlSprites(n, 'distinct'), control);
    const distinct = await draws();
    await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.removeControlSprites());
    await page.evaluate((n) => (window as ProbeWindow).__cryscadeProbe?.addControlSprites(n, 'atlas'), control);
    const atlas = await draws();
    await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.removeControlSprites());
    const again = await draws();
    console.log(`${renderer} (${info.gpu}): покой ${String(idle)}, +${String(control)} разных текстур ${String(distinct)}, +${String(control)} из атласа ${String(atlas)}`);
    writeMeasure(`draw-calls-idle-${renderer}`, { renderer: info.name, gpu: info.gpu, idle, control: { sprites: control, distinct, atlas } });

    expect(idle, 'кадр рисует хоть что-то').toBeGreaterThan(0);
    expect(distinct - idle, 'положительный контроль: разные текстуры рвут батч').toBeGreaterThanOrEqual(2);
    expect(atlas - idle, 'спрайты из атласа батчатся со сценой').toBeLessThanOrEqual(1);
    expect(again, 'контроль убран — счёт вернулся').toBe(idle);
    if (renderer === 'webgl') expect(idle, `бюджет §13: покой ≤ ${String(DRAW_BUDGET.rest)}`).toBeLessThanOrEqual(DRAW_BUDGET.rest);
    // Фаза 5 добавила на сцену показ раунда (подсветки, осколки, плашки, счётчики) — покой от этого не дорожает.
    expect(idle, `потолок покоя ${String(DRAW_CEILING.rest)}`).toBeLessThanOrEqual(DRAW_CEILING.rest);
  });
}
