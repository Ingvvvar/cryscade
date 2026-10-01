import { expect, test } from '../support/fixtures.ts';
import { BROWSER_ENVIRONMENT, mountCounts, sceneInfo, waitSettled } from '../support/page-probe.ts';

// Headless shell: адаптера WebGPU нет, WebGL — SwiftShader (проба фазы 3). Так же будет в CI.
// Без параметра — откат на WebGL; принудительный WebGPU — видимая ошибка, а не тихая подмена.
// Здесь же — положительный контроль фильтра консоли (BROWSER_ENVIRONMENT, общий для всех e2e): сообщения среды без GPU
// в этой среде обязаны прийти, и ничего, кроме них: «No available adapters.» — откат сначала спрашивает WebGPU;
// «GPU stall due to ReadPixels» — headless shell читает кадр WebGL на SwiftShader (проверено на голой странице без Pixi).

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
