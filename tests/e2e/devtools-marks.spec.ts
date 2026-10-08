import { expect, test } from '../support/fixtures.ts';
import { waitForState } from '../support/game-page.ts';
import { collectConsole } from '../support/page-probe.ts';

// Фазы кадра для DevTools (§13, правила замеров) — только dev: на dev-сервере каждый кадр даёт две записи
// performance.measure с detail.devtools — «обновление» и «отрисовка» — на дорожке Cryscade. В прод- и e2e-бандле
// маркера разметки нет — греп с положительным контролем по модулю dev-сервера (bundle.spec.ts).

interface SeenMeasure {
  readonly name: string;
  readonly track: unknown;
  readonly duration: number;
}

type MarksWindow = Window & { __measures?: SeenMeasure[] };

test('dev: фазы кадра — performance.measure с detail.devtools, «обновление» и «отрисовка» на каждом кадре', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.addInitScript(() => {
    const seen: SeenMeasure[] = [];
    (window as MarksWindow).__measures = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail: unknown = (entry as PerformanceMeasure).detail;
        const devtools = typeof detail === 'object' && detail !== null ? (detail as { devtools?: { track?: unknown } }).devtools : undefined;
        seen.push({ name: entry.name, track: devtools?.track, duration: entry.duration });
      }
    }).observe({ type: 'measure' });
  });
  await page.goto('./');
  await waitForState(page, 'idle');
  // Ждём кадров, а не времени: в WebKit без GPU (CI) к покою + 500 мс их было 7.
  const updates = async (): Promise<number> =>
    (await page.evaluate(() => (window as MarksWindow).__measures ?? [])).filter((item) => item.name === 'cryscade: обновление').length;
  await expect.poll(updates, { timeout: 15_000, message: 'кадры с разметкой обновления' }).toBeGreaterThan(10);
  const measures = await page.evaluate(() => (window as MarksWindow).__measures ?? []);
  const update = measures.filter((item) => item.name === 'cryscade: обновление');
  const render = measures.filter((item) => item.name === 'cryscade: отрисовка');
  expect(update.length, 'кадры с разметкой обновления').toBeGreaterThan(10);
  expect(render.length, 'кадры с разметкой отрисовки').toBeGreaterThan(10);
  expect(Math.abs(update.length - render.length), 'по паре на кадр').toBeLessThanOrEqual(1);
  expect(new Set([...update, ...render].map((item) => item.track))).toStrictEqual(new Set(['Cryscade']));
  expect(await page.evaluate(() => performance.getEntriesByType('measure').length), 'буфер не копит записи').toBe(0);
  expect(problems).toEqual([]);
});
