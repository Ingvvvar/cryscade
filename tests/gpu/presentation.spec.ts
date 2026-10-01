import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { ShownRound } from '../../src/client/index.ts';
import type { SymbolId } from '../../src/core/model/symbols.ts';
import type { Rect } from '../../src/render/layout.ts';
import { sceneTextList } from '../../src/render/renderer.ts';
import type { ScheduleSummary } from '../../src/ui/probe-api.ts';
import { SCENE_TEXTS } from '../../src/ui/scene-texts.ts';
import { sceneInfo, waitSettled, type ProbeWindow } from '../support/page-probe.ts';
import { fixtureShown, spotRound } from '../support/shown-rounds.ts';
import { DRAW_BUDGET, DRAW_CEILING } from './support/draw-ceilings.ts';
import { installDrawCounter, type DrawCounts } from './support/draw-counter.ts';
import { PINNED_AMBIENT_S, openStill, snapshot } from './support/frame.ts';
import { MIN_CONTRAST, MIN_PIXELS, backingColour, readCell, repaintBody } from './support/readability.ts';

// Презентация раунда на сцене (фаза 5, подход Б): кадры ставит зонд (still — показ стоит на моменте t).
// 1. Draw-call на ключевых кадрах — середина каждого сегмента четырёх раундов фикстур, с первой отрисовки кадра (страницы
//    глифов грузит прогрев): потолки-храповик DRAW_CEILING на обоих рендерерах, бюджет §13 (WebGL) — внешняя граница;
//    сначала положительный контроль счётчика — разные текстуры рвут батч.
// 2. Читаемость на подложках множителей (решение владельца 8): семь уровней × восемь символов на реальном кадре,
//    медиана символа против p95 подложки ≥ 3:1; плашка числа — не подложка, её рамку от зонда вычитают.
// 3. Глифы: ни одного недостающего в шрифтах надписей и чисел; контроль — символ вне набора находится.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/phase-5/`;
const NAMES = ['Кварц', 'Аметист', 'Цитрин', 'Изумруд', 'Сапфир', 'Рубин', 'Бриллиант', 'Ядро'];

type CountWindow = ProbeWindow & { __drawCounts?: DrawCounts };

async function scheduleOf(page: Page, round: ShownRound): Promise<ScheduleSummary> {
  const schedule = await page.evaluate((shown) => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    probe?.still(shown, 0);
    return probe?.schedule() ?? null;
  }, round);
  if (schedule === null) throw new Error('нет расписания');
  return schedule;
}

/**
 * Draw-call кадра: показ стоит на t, тикер остановлен, счёт — с первой отрисовки кадра. Страницы глифов грузит в GPU
 * прогрев (§10), и WebGPU не строит их мипмапы проходами с draw посреди кадра.
 */
async function drawsAt(page: Page, round: ShownRound, t: number, renderer: 'webgl' | 'webgpu'): Promise<number> {
  const counts = await page.evaluate(
    ({ shown, at }) => {
      const w = window as CountWindow;
      const counter = w.__drawCounts;
      if (counter === undefined) throw new Error('счётчик draw-call не установлен');
      w.__cryscadeProbe?.still(shown, at);
      counter.gl = 0;
      counter.gpu = 0;
      counter.executeBundles = 0;
      w.__cryscadeProbe?.renderOnce();
      return { ...counter };
    },
    { shown: round, at: t },
  );
  expect(counts.executeBundles, 'бандлы рендера: счёт был бы неполным').toBe(0);
  return renderer === 'webgl' ? counts.gl : counts.gpu;
}

interface Worst {
  readonly draws: number;
  readonly round: ShownRound | null;
  readonly segment: string;
  readonly t: number;
}

const describeWorst = (worst: Worst): string => `${String(worst.draws)} (${worst.round?.roundId ?? '—'}, ${worst.segment}, t = ${String(worst.t)})`;

for (const renderer of ['webgl', 'webgpu'] as const) {
  test(`${renderer}: draw-call на кадрах каскада, фичи и большого выигрыша`, async ({ page }) => {
    await page.addInitScript(installDrawCounter);
    await page.goto(`./?renderer=${renderer}`);
    await waitSettled(page);
    const info = await sceneInfo(page);
    expect(info.name).toBe(renderer);
    expect(info.software, `на программном рендере не мерим: ${info.gpu}`).toBe(false);
    await page.evaluate((seconds) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      probe?.stopTicker();
      probe?.pinAmbient(seconds);
    }, PINNED_AMBIENT_S);

    let cascade: Worst = { draws: 0, round: null, segment: '', t: 0 };
    let bigWin: Worst = { draws: 0, round: null, segment: '', t: 0 };
    let frames = 0;
    for (const name of ['multiplier-8', 'feature-start', 'retrigger', 'biggest'] as const) {
      const round = fixtureShown(name);
      const schedule = await scheduleOf(page, round);
      for (const segment of schedule.segments) {
        if (segment.endMs <= segment.startMs) continue;
        const t = Math.floor((segment.startMs + segment.endMs) / 2);
        const draws = await drawsAt(page, round, t, renderer);
        frames += 1;
        const kind = schedule.groups[segment.group]?.kind;
        const worst = { draws, round, segment: segment.kind, t };
        if (kind === 'bigWin') {
          if (draws > bigWin.draws) bigWin = worst;
        } else if (draws > cascade.draws) {
          cascade = worst;
        }
      }
    }
    // Контроль на худшем кадре каскада: 3 × maxBatchableTextures разных текстур поднимают счёт хотя бы на 2.
    const control = 3 * info.maxBatchableTextures;
    const worstRound = cascade.round;
    if (worstRound === null) throw new Error('кадров каскада нет');
    await page.evaluate((n) => (window as ProbeWindow).__cryscadeProbe?.addControlSprites(n, 'distinct'), control);
    const withControl = await drawsAt(page, worstRound, cascade.t, renderer);
    await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.removeControlSprites());
    const again = await drawsAt(page, worstRound, cascade.t, renderer);
    console.log(
      `${renderer} (${info.gpu}): кадров ${String(frames)}; каскад и фича — ${describeWorst(cascade)}; большой выигрыш — ${describeWorst(bigWin)}; контроль +${String(control)} текстур: ${String(withControl)}`,
    );

    expect(frames, 'кадры нашлись').toBeGreaterThan(100);
    expect(bigWin.draws, 'кадры большого выигрыша нашлись и что-то рисуют').toBeGreaterThan(0);
    expect(withControl - cascade.draws, 'положительный контроль: разные текстуры рвут батч').toBeGreaterThanOrEqual(2);
    expect(again, 'контроль убран — счёт вернулся').toBe(cascade.draws);
    if (renderer === 'webgl') {
      expect(cascade.draws, `бюджет §13: каскад ≤ ${String(DRAW_BUDGET.cascade)}`).toBeLessThanOrEqual(DRAW_BUDGET.cascade);
      expect(bigWin.draws, `бюджет §13: большой выигрыш ≤ ${String(DRAW_BUDGET.bigWin)}`).toBeLessThanOrEqual(DRAW_BUDGET.bigWin);
    }
    expect(cascade.draws, `потолок каскада и фичи ${String(DRAW_CEILING.cascade)}: ${describeWorst(cascade)}`).toBeLessThanOrEqual(DRAW_CEILING.cascade);
    expect(bigWin.draws, `потолок большого выигрыша ${String(DRAW_CEILING.bigWin)}: ${describeWorst(bigWin)}`).toBeLessThanOrEqual(DRAW_CEILING.bigWin);
  });
}

// Кадры точек: A — символы 0…6 по колонкам, уровни ×2…×128 по строкам; B — Ядро во всех клетках, уровни по строкам.
const LEVELS = Array.from({ length: 49 }, (_, cell) => Math.floor(cell / 7) + 2);
const SPOT_FRAMES: readonly { readonly name: string; readonly grid: readonly SymbolId[] }[] = [
  { name: 'символы 0…6', grid: Array.from({ length: 49 }, (_, cell) => (cell % 7) as SymbolId) },
  { name: 'Ядро', grid: Array.from({ length: 49 }, (): SymbolId => 7) },
];

const device = (rect: Rect, dpr: number): Rect => ({ x: rect.x * dpr, y: rect.y * dpr, width: rect.width * dpr, height: rect.height * dpr });

for (const renderer of ['webgl', 'webgpu'] as const) {
  test(`${renderer}: читаемость на подложках множителей — 7 уровней × 8 символов ≥ ${String(MIN_CONTRAST)}:1`, async ({ browser }) => {
    const dpr = 2;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    const info = await openStill(page, `?renderer=${renderer}`);
    expect(info.name).toBe(renderer);
    expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
    const layout = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.layout() ?? null);
    if (layout === null) throw new Error('нет раскладки');
    const unit = layout.scale * dpr;
    const table: Record<string, Record<string, number>> = {};
    let measured = 0;
    for (const frame of SPOT_FRAMES) {
      const round = spotRound(frame.grid, LEVELS);
      await page.evaluate((shown) => {
        (window as ProbeWindow).__cryscadeProbe?.still(shown, Number.MAX_SAFE_INTEGER);
      }, round);
      await page.clock.runFor(100);
      const { cells, chips } = await page.evaluate(() => {
        const probe = (window as ProbeWindow).__cryscadeProbe;
        return { cells: probe?.cells() ?? [], chips: probe?.chipRects() ?? [] };
      });
      expect(chips, 'плашка у каждой клетки с множителем').toHaveLength(49);
      const exclude = chips.map((chip) => device(chip.plaque, dpr));
      const shot = await snapshot(page);
      writeFileSync(`${mkdir()}multipliers-${frame.name === 'Ядро' ? 'core' : 'symbols'}-${renderer}.png`, shot.png);
      // Контроль инструмента на этом кадре: символ цвета подложки не читается, белый — контрастнее.
      const rect0 = device(cells[0] ?? { x: 0, y: 0, width: 0, height: 0 }, dpr);
      const symbol0 = frame.grid[0] ?? 0;
      const flat = readCell(repaintBody(shot.image, rect0, symbol0, unit, backingColour(shot.image, rect0, symbol0, unit, exclude), exclude), 0, rect0, symbol0, unit, exclude);
      expect(flat.ratio, 'контроль: символ цвета подложки').toBeLessThan(MIN_CONTRAST);
      const white = readCell(repaintBody(shot.image, rect0, symbol0, unit, [255, 255, 255], exclude), 0, rect0, symbol0, unit, exclude);
      const plain = readCell(shot.image, 0, rect0, symbol0, unit, exclude);
      expect(white.ratio, 'контроль: белый символ контрастнее').toBeGreaterThan(plain.ratio);
      const weak: string[] = [];
      cells.forEach((rect, cell) => {
        const symbol = frame.grid[cell] ?? 0;
        const level = LEVELS[cell] ?? 0;
        const reading = readCell(shot.image, cell, device(rect, dpr), symbol, unit, exclude);
        expect(reading.bodyPixels, `клетка ${String(cell)}: тело`).toBeGreaterThanOrEqual(MIN_PIXELS);
        expect(reading.ringPixels, `клетка ${String(cell)}: подложка`).toBeGreaterThanOrEqual(MIN_PIXELS);
        const key = `×${String(2 ** (level - 1))}`;
        const row = (table[key] ??= {});
        const name = NAMES[symbol] ?? String(symbol);
        row[name] = Math.min(row[name] ?? Number.POSITIVE_INFINITY, Number(reading.ratio.toFixed(2)));
        measured += 1;
        if (reading.ratio < MIN_CONTRAST) weak.push(`клетка ${String(cell)} ${name} ${key}: ${reading.ratio.toFixed(2)}`);
      });
      expect(weak, `контраст символа и подложки множителя (${frame.name})`).toEqual([]);
    }
    expect(measured).toBe(98);
    expect(Object.keys(table)).toHaveLength(7);
    for (const row of Object.values(table)) expect(Object.keys(row)).toHaveLength(8);
    writeFileSync(`${mkdir()}multipliers-${renderer}.json`, `${JSON.stringify({ renderer: info.name, gpu: info.gpu, minContrast: table }, null, 2)}\n`);
    await context.close();
  });
}

// Плашки множителей (§9): кегль числа 22 ед., плашка — в пределах подложки своей клетки (отступ подложки 3 ед.), число и
// замок — по ширине в пределах плашки; и обычная, и запертая во фриспинах. Ширина обычной — независимым счётом: сумма
// ширин глифов Unbounded 700 из canvas страницы (так их меряет BitmapFont) × 22 / 64 плюс поля 2 × 7, не меньше 56.
test('webgl: плашки множителей — кегль 22, в пределах подложки клетки, обычные и запертые', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const info = await openStill(page, '?renderer=webgl');
  expect(info.name).toBe('webgl');
  const layout = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.layout() ?? null);
  if (layout === null) throw new Error('нет раскладки');
  const unit = layout.scale;
  const labels = LEVELS.map((level) => `×${String(2 ** (level - 1))}`);
  const advance = await page.evaluate((texts) => {
    const context2d = document.createElement('canvas').getContext('2d');
    if (context2d === null) throw new Error('нет canvas 2d');
    context2d.font = '700 64px "Unbounded Variable"';
    return texts.map((text) => Array.from(text).reduce((sum, char) => sum + context2d.measureText(char).width, 0));
  }, labels);
  const grid = Array.from({ length: 49 }, (_, cell) => cell % 7);
  for (const locked of [false, true]) {
    await page.evaluate((shown) => {
      (window as ProbeWindow).__cryscadeProbe?.still(shown, Number.MAX_SAFE_INTEGER);
    }, spotRound(grid, LEVELS, locked));
    await page.clock.runFor(100);
    const { cells, chips } = await page.evaluate(() => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      return { cells: probe?.cells() ?? [], chips: probe?.chipRects() ?? [] };
    });
    expect(chips, 'плашка у каждой клетки').toHaveLength(49);
    const box = (r: Rect): string => `${r.x.toFixed(1)}…${(r.x + r.width).toFixed(1)} × ${r.y.toFixed(1)}…${(r.y + r.height).toFixed(1)}`;
    const slack = 0.5;
    const outside: string[] = [];
    const spills: string[] = [];
    const widths: string[] = [];
    cells.forEach((cell, index) => {
      const chip = chips[index];
      if (chip === undefined) throw new Error(`нет плашки клетки ${String(index)}`);
      const { plaque, content } = chip;
      const name = `клетка ${String(index)} ${labels[index] ?? ''}${locked ? ' с замком' : ''}`;
      const inset = 3 * unit;
      if (
        plaque.x < cell.x + inset - slack ||
        plaque.x + plaque.width > cell.x + cell.width - inset + slack ||
        plaque.y < cell.y + inset - slack ||
        plaque.y + plaque.height > cell.y + cell.height - inset + slack
      ) {
        outside.push(`${name}: плашка ${box(plaque)}, клетка ${box(cell)}`);
      }
      if (content.x < plaque.x - slack || content.x + content.width > plaque.x + plaque.width + slack) {
        spills.push(`${name}: число и замок ${box(content)}, плашка ${box(plaque)}`);
      }
      const expected = Math.max(56, ((advance[index] ?? 0) * 22) / 64 + 14) * unit;
      if (!locked && Math.abs(plaque.width - expected) > 0.5) {
        widths.push(`${name}: ${plaque.width.toFixed(2)} при ожидании ${expected.toFixed(2)}`);
      }
    });
    expect(outside, 'плашка вышла за подложку клетки').toEqual([]);
    expect(spills, 'число и замок вышли за плашку').toEqual([]);
    expect(widths, 'ширина плашки — по кеглю 22').toEqual([]);
  }
  await context.close();
});

test('глифы: в шрифтах надписей и чисел нет недостающих; кириллица Unbounded загружена', async ({ page }) => {
  await page.goto('./?renderer=webgl');
  await waitSettled(page);
  const info = await sceneInfo(page);
  expect(info.fontReady, 'document.fonts видел Unbounded с текстом надписей').toBe(true);
  const { scene, control, languages } = await page.evaluate(
    (texts) => {
      const probe = (window as ProbeWindow).__cryscadeProbe;
      return { scene: probe?.missingGlyphs() ?? null, control: probe?.missingGlyphs(['Ωж€']) ?? null, languages: probe?.missingGlyphs(texts) ?? null };
    },
    [...sceneTextList(SCENE_TEXTS.uk), ...sceneTextList(SCENE_TEXTS.en)],
  );
  expect(control, 'контроль: символы вне набора находятся').toStrictEqual(['Ω', '€']);
  expect(scene).toStrictEqual([]);
  expect(languages, 'надписи обоих языков — в шрифте надписей сразу').toStrictEqual([]);
});

function mkdir(): string {
  mkdirSync(OUT, { recursive: true });
  return OUT;
}
