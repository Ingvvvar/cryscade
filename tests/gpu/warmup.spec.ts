import { expect, test, type Page } from '@playwright/test';
import { waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { fixtureShown } from '../support/shown-rounds.ts';
import { installPipelineCounter, type PipelineCounts } from './support/pipeline-counter.ts';

// Прогрев шейдеров (§10): после события «сцена готова» — первый видимый кадр и падение сетки — новых конвейеров
// (WebGPU) и программ (WebGL) нет. Контроль: ?warmup=off (только e2e-сборка) — первый кадр их создаёт.
// Фаза 5: и на кадрах каскада — подсветки (аддитивно), контуры, осколки и вспышки, числа множителей, плашки фичи,
// большой выигрыш: в момент init их на сцене нет, прогрев обязан собрать их конвейеры заранее.

type CountWindow = ProbeWindow & { __pipelineCounts?: PipelineCounts };

async function counts(page: Page): Promise<PipelineCounts> {
  const found = await page.evaluate(() => {
    const value = (window as CountWindow).__pipelineCounts;
    return value === undefined ? null : { ...value };
  });
  if (found === null) throw new Error('счётчик конвейеров не установлен');
  return found;
}

/** Все сегменты раундов с каскадом, фичей и большим выигрышем — по кадру на середину, отрисовка сразу. */
async function playCascadeFrames(page: Page): Promise<number> {
  let frames = 0;
  for (const name of ['multiplier-8', 'feature-start'] as const) {
    frames += await page.evaluate((round) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      probe?.still(round, 0);
      const segments = probe?.schedule()?.segments ?? [];
      let rendered = 0;
      for (const segment of segments) {
        if (segment.endMs <= segment.startMs) continue;
        probe?.still(round, Math.floor((segment.startMs + segment.endMs) / 2));
        probe?.renderOnce();
        rendered += 1;
      }
      return rendered;
    }, fixtureShown(name));
  }
  return frames;
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  for (const warm of [true, false]) {
    test(`${renderer}: ${warm ? 'после прогрева кадры не создают конвейеров' : 'без прогрева (контроль) — создают'}`, async ({ page }) => {
      await page.addInitScript(installPipelineCounter);
      await page.goto(`./?renderer=${renderer}${warm ? '' : '&warmup=off'}`);
      await waitSettled(page);
      await page.waitForTimeout(300);
      const settled = await counts(page);
      console.log(`${renderer}, прогрев ${warm ? 'есть' : 'нет'}: до готовности ${String(settled.atReady)}, всего ${String(settled.total)}`);
      expect(settled.readySeen, 'событие готовности сцены').toBe(true);
      expect(settled.atReady, 'счётчик видит создание конвейеров').toBeGreaterThan(0);
      if (warm) expect(settled.total - settled.atReady).toBe(0);
      else expect(settled.total - settled.atReady).toBeGreaterThan(0);
    });
  }

  for (const warm of [true, false]) {
    test(`${renderer}: кадры каскада, фичи и большого выигрыша — ${warm ? 'после прогрева без новых конвейеров' : 'без прогрева (контроль) — с новыми'}`, async ({ page }) => {
      await page.addInitScript(installPipelineCounter);
      await page.goto(`./?renderer=${renderer}${warm ? '' : '&warmup=off'}`);
      await waitSettled(page);
      await page.evaluate(() => {
        (window as ProbeWindow).__cryscadeProbe?.stopTicker();
      });
      const before = await counts(page);
      const frames = await playCascadeFrames(page);
      const after = await counts(page);
      console.log(`${renderer}, прогрев ${warm ? 'есть' : 'нет'}: кадров каскада ${String(frames)}, новых конвейеров ${String(after.total - before.total)}, с начала после готовности ${String(after.total - after.atReady)}`);
      expect(frames, 'кадры нашлись').toBeGreaterThan(50);
      if (warm) expect(after.total - after.atReady, 'после готовности конвейеров не прибавилось').toBe(0);
      else expect(after.total - after.atReady, 'контроль: без прогрева конвейеры собираются в кадрах').toBeGreaterThan(0);
    });
  }
}
