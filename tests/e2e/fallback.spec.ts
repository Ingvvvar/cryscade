import { expect, test } from '@playwright/test';
import { collectConsole, mountCounts, sceneInfo, waitSettled } from '../support/page-probe.ts';

// Headless shell: адаптера WebGPU нет, WebGL — SwiftShader (проба фазы 3). Так же будет в CI.
// Без параметра — откат на WebGL; принудительный WebGPU — видимая ошибка, а не тихая подмена.

// Сообщения самого браузера в этой среде, не игры (проверено на голой странице без Pixi):
// - «No available adapters.» — requestAdapter без адаптера: откат обязан сначала спросить WebGPU;
// - «GPU stall due to ReadPixels» — headless shell считывает кадр WebGL на SwiftShader при программной сборке кадра.
const BROWSER_ENVIRONMENT = [/^warning: No available adapters\.$/, /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/];

test('без ?renderer= откат на WebGL работает, и программный рендер назван программным', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./');
  await waitSettled(page);
  const info = await sceneInfo(page);
  expect(info.name).toBe('webgl');
  expect(info.software).toBe(true);
  expect(info.gpu).toMatch(/swiftshader/i);
  expect(problems.filter((text) => !BROWSER_ENVIRONMENT.some((pattern) => pattern.test(text)))).toEqual([]);
});

test('?renderer=webgpu без WebGPU — видимая ошибка, канваса нет, отката нет', async ({ page }) => {
  await page.goto('./?renderer=webgpu');
  await expect(page.getByRole('alert')).toContainText('webgpu');
  expect(await page.locator('canvas').count()).toBe(0);
  const counts = await mountCounts(page);
  expect(counts.created).toBe(1);
  expect(counts.inits).toBe(0);
});
