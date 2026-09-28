import { expect, test } from '@playwright/test';
import { waitSettled } from '../support/page-probe.ts';
import { installPipelineCounter, type PipelineCounts } from './support/pipeline-counter.ts';

// Прогрев шейдеров (§10): после события «сцена готова» — первый видимый кадр и падение сетки — новых конвейеров
// (WebGPU) и программ (WebGL) нет. Контроль: ?warmup=off (только e2e-сборка) — первый кадр их создаёт.

type CountWindow = Window & { __pipelineCounts?: PipelineCounts };

for (const renderer of ['webgl', 'webgpu'] as const) {
  for (const warm of [true, false]) {
    test(`${renderer}: ${warm ? 'после прогрева кадры не создают конвейеров' : 'без прогрева (контроль) — создают'}`, async ({ page }) => {
      await page.addInitScript(installPipelineCounter);
      await page.goto(`./?renderer=${renderer}${warm ? '' : '&warmup=off'}`);
      await waitSettled(page);
      await page.waitForTimeout(300);
      const counts = await page.evaluate(() => (window as CountWindow).__pipelineCounts ?? null);
      if (counts === null) throw new Error('счётчик конвейеров не установлен');
      console.log(`${renderer}, прогрев ${warm ? 'есть' : 'нет'}: до готовности ${String(counts.atReady)}, всего ${String(counts.total)}`);
      expect(counts.readySeen, 'событие готовности сцены').toBe(true);
      expect(counts.atReady, 'счётчик видит создание конвейеров').toBeGreaterThan(0);
      if (warm) expect(counts.total - counts.atReady).toBe(0);
      else expect(counts.total - counts.atReady).toBeGreaterThan(0);
    });
  }
}
