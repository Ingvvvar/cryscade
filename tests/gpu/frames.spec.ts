import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { PALETTE } from '../../src/render/art/palette.ts';
import type { Insets, Rect } from '../../src/render/layout.ts';
import { firstGrid } from '../../src/ui/fixture-grid.ts';
import { encodePng, luminance, decodePng, type Image } from '../support/png.ts';
import type { ProbeWindow } from '../support/page-probe.ts';
import { difference, fakeSafeArea, openStill, snapshot } from './support/frame.ts';
import { MIN_CONTRAST, MIN_PIXELS, backingColour, readCell, repaintBody, type CellReading } from './support/readability.ts';

// Кадры для глаз владельца (§15, фаза 3) — в одну папку reports/phase-3/: портрет и ландшафт × WebGPU и WebGL,
// атлас в цвете и в сером, shots.json. Каждый снимок подписан фактическим рендерером. На каждом кадре — читаемость
// по пикселям (контраст ≥ 3:1 у всех 49 символов) и стабильность; у обеих проверок сначала положительный контроль.
// Стабильность: сцена (панель скрыта) через секунду совпадает байт в байт. Полный кадр с панелью — не хуже 1/255
// в 0.01 % пикселей: радиальный градиент кнопки «Спін» браузер растеризует от раза к разу с разницей в 1/255
// (найдено на повторах; рамка расхождения — ровно кнопка), это растеризация CSS, не рендер игры.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/phase-3/`;
const GRID = firstGrid(JSON.parse(readFileSync(`${ROOT}fixtures/rounds/feature-start.json`, 'utf8')));
const NAMES = ['Кварц', 'Аметист', 'Цитрин', 'Изумруд', 'Сапфир', 'Рубин', 'Бриллиант', 'Ядро'];

interface Frame {
  readonly orientation: 'portrait' | 'landscape';
  readonly viewport: { readonly width: number; readonly height: number };
  readonly dpr: number;
  readonly insets: Insets | null;
}

const FRAMES: readonly Frame[] = [
  { orientation: 'portrait', viewport: { width: 390, height: 844 }, dpr: 3, insets: { top: 47, right: 0, bottom: 34, left: 0 } },
  { orientation: 'landscape', viewport: { width: 1440, height: 900 }, dpr: 2, insets: null },
];

const manifest: Record<string, unknown>[] = [];
mkdirSync(OUT, { recursive: true });

const device = (rect: Rect, dpr: number): Rect => ({ x: rect.x * dpr, y: rect.y * dpr, width: rect.width * dpr, height: rect.height * dpr });

for (const renderer of ['webgpu', 'webgl'] as const) {
  for (const frame of FRAMES) {
    test(`${frame.orientation}, ${renderer}: снимок, читаемость ≥ ${String(MIN_CONTRAST)}:1, стабильность`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: frame.viewport, deviceScaleFactor: frame.dpr });
      const page = await context.newPage();
      if (frame.insets !== null) await fakeSafeArea(page, frame.insets);
      const info = await openStill(page, `?renderer=${renderer}`);
      expect(info.name, 'фактический рендерер').toBe(renderer);
      expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
      expect(info.fontReady, 'BitmapFont поставлен после загрузки Unbounded').toBe(true);
      const { layout, cells } = await page.evaluate(() => {
        const probe = (window as ProbeWindow).__cryscadeProbe;
        return { layout: probe?.layout() ?? null, cells: probe?.cells() ?? [] };
      });
      if (layout === null) throw new Error('нет раскладки');
      expect(layout.orientation).toBe(frame.orientation);
      if (frame.insets !== null) expect(layout.safe.y).toBe(frame.insets.top);
      const unit = layout.scale * frame.dpr;

      const first = await snapshot(page);

      // Читаемость. Сначала контроль: тело символа, закрашенное цветом подложки, инструмент обязан поймать.
      const rect0 = device(cells[0] ?? { x: 0, y: 0, width: 0, height: 0 }, frame.dpr);
      const symbol0 = GRID[0] ?? 0;
      const flat = readCell(repaintBody(first.image, rect0, symbol0, unit, backingColour(first.image, rect0, symbol0, unit)), 0, rect0, symbol0, unit);
      expect(flat.ratio, 'контроль: символ цвета подложки').toBeLessThan(MIN_CONTRAST);
      const white = readCell(repaintBody(first.image, rect0, symbol0, unit, [255, 255, 255]), 0, rect0, symbol0, unit);
      const readings: CellReading[] = cells.map((rect, cell) => readCell(first.image, cell, device(rect, frame.dpr), GRID[cell] ?? 0, unit));
      expect(white.ratio, 'контроль: белый символ контрастнее').toBeGreaterThan(readings[0]?.ratio ?? Number.POSITIVE_INFINITY);
      expect(readings).toHaveLength(49);
      expect(readings.filter((r) => r.bodyPixels < MIN_PIXELS || r.ringPixels < MIN_PIXELS), 'неразобранные клетки').toEqual([]);
      const weak = readings.filter((r) => r.ratio < MIN_CONTRAST).map((r) => `клетка ${String(r.cell)} ${NAMES[r.symbol] ?? ''}: ${r.ratio.toFixed(2)}`);
      expect(weak, 'контраст символа и подложки').toEqual([]);

      // Стабильность: часы стоят, декор закреплён. Полный кадр — в пределах дрожания растеризации CSS.
      await page.clock.runFor(1000);
      const again = await snapshot(page);
      const drift = difference(again.image, first.image);
      expect(drift.max, `полный кадр через секунду: ${JSON.stringify(drift)}`).toBeLessThanOrEqual(1 / 255);
      expect(drift.pixels, `полный кадр через секунду: ${JSON.stringify(drift)}`).toBeLessThanOrEqual(first.image.width * first.image.height * 1e-4);
      // Сцена без панели — байт в байт. Контроль: закрепление декора снято — сцена меняется.
      await page.addStyleTag({ content: '.panel { display: none !important; }' });
      await page.clock.runFor(100);
      const scene = await snapshot(page);
      await page.clock.runFor(1000);
      const sceneAgain = await snapshot(page);
      expect(difference(sceneAgain.image, scene.image), 'сцена через секунду').toStrictEqual({ mean: 0, max: 0, pixels: 0, box: [] });
      await page.evaluate(() => {
        (window as ProbeWindow).__cryscadeProbe?.pinAmbient(null);
      });
      await page.clock.runFor(1000);
      const moved = await snapshot(page);
      expect(difference(moved.image, sceneAgain.image).max, 'контроль: снятое закрепление меняет сцену').toBeGreaterThan(0);

      const file = `${frame.orientation}-${info.name}.png`;
      writeFileSync(`${OUT}${file}`, first.png);
      const bySymbol = new Map<number, number>();
      for (const r of readings) bySymbol.set(r.symbol, Math.min(bySymbol.get(r.symbol) ?? Number.POSITIVE_INFINITY, r.ratio));
      manifest.push({
        file,
        requested: renderer,
        actual: info.name,
        gpu: info.gpu,
        viewport: frame.viewport,
        dpr: frame.dpr,
        resolution: info.resolution,
        insets: frame.insets,
        minContrastBySymbol: Object.fromEntries([...bySymbol].sort((a, b) => a[0] - b[0]).map(([s, ratio]) => [NAMES[s] ?? String(s), Number(ratio.toFixed(2))])),
      });
      await context.close();
    });
  }
}

function composite(image: Image, background: number, grey: boolean): Image {
  const rgba = new Uint8Array(image.rgba.length);
  const bg = [(background >> 16) & 0xff, (background >> 8) & 0xff, background & 0xff];
  const encode = (y: number): number => Math.round(255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055));
  for (let i = 0; i < image.rgba.length; i += 4) {
    const a = (image.rgba[i + 3] ?? 0) / 255;
    const rgb = [0, 1, 2].map((c) => Math.round((image.rgba[i + c] ?? 0) * a + (bg[c] ?? 0) * (1 - a)));
    const [r = 0, g = 0, b = 0] = rgb;
    const out = grey ? [encode(luminance(r, g, b)), encode(luminance(r, g, b)), encode(luminance(r, g, b))] : [r, g, b];
    rgba.set([...out, 255], i);
  }
  return { width: image.width, height: image.height, rgba };
}

test('атлас в цвете и в сером — на подложке cave-1', async ({ page }) => {
  await page.goto('./?renderer=webgl');
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.settled() ?? false)).toBe(true);
  const url = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.atlasPng() ?? Promise.resolve(null));
  if (url === null) throw new Error('атлас не выгружен');
  const atlas = decodePng(Buffer.from(url.split(',')[1] ?? '', 'base64'));
  expect(atlas.width).toBe(2048);
  expect(atlas.height).toBeLessThanOrEqual(2048);
  expect(Math.log2(atlas.height) % 1).toBe(0);
  writeFileSync(`${OUT}atlas.png`, encodePng(composite(atlas, PALETTE.cave1, false)));
  writeFileSync(`${OUT}atlas-gray.png`, encodePng(composite(atlas, PALETTE.cave1, true)));
});

test('начальный JS по рендерерам (§10: ленивые загрузчики бэкенда)', async ({ browser }) => {
  const sizes: Record<string, { files: number; gzip: number }> = {};
  for (const renderer of ['webgpu', 'webgl'] as const) {
    const page = await browser.newPage();
    const bodies: Promise<Buffer>[] = [];
    page.on('response', (response) => {
      if (response.url().endsWith('.js')) bodies.push(response.body());
    });
    await page.goto(`./?renderer=${renderer}`);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.settled() ?? false)).toBe(true);
    const all = await Promise.all(bodies);
    sizes[renderer] = { files: all.length, gzip: all.reduce((sum, body) => sum + gzipSync(body).length, 0) };
    await page.close();
  }
  console.log(`начальный JS (e2e-сборка, с зондом): ${JSON.stringify(sizes)}`);
  manifest.push({ initialJsGzipBytes: sizes });
});

test.afterAll(() => {
  writeFileSync(`${OUT}shots.json`, `${JSON.stringify(manifest, null, 2)}\n`);
});
