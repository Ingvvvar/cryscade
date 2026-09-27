import { expect, test } from '@playwright/test';
import { sceneInfo, waitSettled } from '../support/page-probe.ts';

// Снимки и замеры подписываются фактическим рендерером: запросили WebGPU, получили WebGL — тест красный,
// а не тихий откат. Программный рендер (SwiftShader, запасной адаптер) замерам не годится — тоже красный.

for (const requested of ['webgpu', 'webgl'] as const) {
  test(`запрошен ${requested} — он и получен, на настоящем GPU`, async ({ page }) => {
    await page.goto(`./?renderer=${requested}`);
    await waitSettled(page);
    const info = await sceneInfo(page);
    console.log(`${requested}: ${info.name} — ${info.gpu}`);
    expect(info.name, 'фактический рендерер').toBe(requested);
    expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
    expect(info.resolution).toBeLessThanOrEqual(2);
  });
}
