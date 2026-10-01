import { expect, test, type Page } from '@playwright/test';
import type { ForcedName } from '../../src/ui/forced-rounds.ts';
import { FRAME_TAGS, type FrameSamples } from '../../src/ui/probe-api.ts';
import { writeMeasure } from '../gpu/support/phase9.ts';
import { readStorage, waitForState } from '../support/game-page.ts';
import { collectConsole, sceneInfo, type ProbeWindow } from '../support/page-probe.ts';

// Время кадра (§13, фаза 9) — изнутри кадра: зонд пишет длительность от первого слушателя тикера приложения до
// последнего, уже после render Pixi, и метку кадра по показу (покой, каскад — раунд основной игры, фича — группы с
// фриспинами и плашка, большой выигрыш — празднование). Настоящий тикер на GPU: строка рендерера — в отчёт, программный
// рендер — отказ. Прогон: 3 с покоя, каскад (сид 512), фича (48: плашка — тапом через секунду), большой выигрыш 72×
// (1590) и кап (801200: до празднования — тапами, празднование — целиком). Пять прогонов на рендерер, в отчёт — худшее из
// пяти. Порога нет: его ставит телефон (§16, проверка владельца). Инструмент сначала ловит положительный контроль:
// 4 мс работы в каждом кадре — внутри замера, медиана покоя с ними не меньше 4 мс. Рост не обязан быть ровно 4 мс: на
// WebGPU часть кадра — ожидание конвейера, и занятый процессор его перекрывает (проба: 0.70 → 4.00 мс).

const RUNS = 5;
const VIEWPORT = { width: 1440, height: 900 } as const;
const DPR = 2;
/** Кадр длиннее 60 Гц. */
const FRAME_60_MS = 1000 / 60;

type Tag = (typeof FRAME_TAGS)[number];

interface TagStats {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly over60: number;
}

/** Ближайший ранг: значение, не меньше которого доля p выборки. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function statsOf(samples: FrameSamples): Record<Tag, TagStats> {
  const entries = FRAME_TAGS.map((tag, index): [Tag, TagStats] => {
    const values = samples.ms.filter((_, at) => samples.tags[at] === index).sort((a, b) => a - b);
    return [
      tag,
      {
        frames: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: values.at(-1) ?? 0,
        over60: values.filter((value) => value > FRAME_60_MS).length,
      },
    ];
  });
  return Object.fromEntries(entries) as Record<Tag, TagStats>;
}

/** Худшее из прогонов по каждой метке и показателю; кадров — наименьшее. */
function worstOf(runs: readonly Record<Tag, TagStats>[]): Record<Tag, TagStats> {
  const entries = FRAME_TAGS.map((tag): [Tag, TagStats] => {
    const all = runs.map((run) => run[tag]);
    const max = (pick: (stats: TagStats) => number): number => Math.max(...all.map(pick));
    return [tag, { frames: Math.min(...all.map((stats) => stats.frames)), p50: max((s) => s.p50), p95: max((s) => s.p95), p99: max((s) => s.p99), max: max((s) => s.max), over60: max((s) => s.over60) }];
  });
  return Object.fromEntries(entries) as Record<Tag, TagStats>;
}

async function closedRounds(page: Page): Promise<number> {
  return (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length;
}

function stateName(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.game()?.state.name ?? null);
}

/** Группа показа сейчас — её вид; показа нет — null. */
function groupKind(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    const schedule = probe?.schedule() ?? null;
    const shown = probe?.presentation() ?? null;
    return schedule === null || shown === null ? null : (schedule.groups[shown.group]?.kind ?? null);
  });
}

/**
 * Принудительный раунд на настоящих часах: «Спін» — клик; плашку фриспинов продолжает тап через секунду; skip — до
 * празднования тапами (синтетический ввод приводит игру в состояние), празднование — целиком.
 */
async function playRound(page: Page, round: ForcedName, skip = false): Promise<void> {
  const before = await closedRounds(page);
  await page.evaluate((name) => (window as ProbeWindow).__cryscadeProbe?.force(name), round);
  await page.getByRole('button', { name: 'Спін' }).click();
  if (skip) {
    for (let taps = 0; taps < 300 && (await groupKind(page)) !== 'bigWin'; taps++) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(40);
    }
    expect(await groupKind(page), `${round}: празднование`).toBe('bigWin');
  }
  let tapped = false;
  await expect
    .poll(
      async () => {
        if (!tapped && (await stateName(page)) === 'featureIntro') {
          tapped = true;
          await page.waitForTimeout(1000);
          await page.keyboard.press('Space');
        }
        return closedRounds(page);
      },
      { timeout: 180_000, intervals: [100] },
    )
    .toBe(before + 1);
  await waitForState(page, 'idle');
}

/** Размер атласа — по заголовку PNG, который выгрузил зонд (IHDR: ширина и высота, байты 16–23). */
async function atlasSize(page: Page): Promise<{ width: number; height: number }> {
  const url = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.atlasPng() ?? null);
  if (url === null) throw new Error('нет атласа');
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function openGame(page: Page, renderer: 'webgl' | 'webgpu'): Promise<string> {
  await page.goto(`./?renderer=${renderer}`);
  await waitForState(page, 'idle');
  const info = await sceneInfo(page);
  expect(info.name, 'фактический рендерер').toBe(renderer);
  expect(info.software, `программный рендер — не мерим: ${info.gpu}`).toBe(false);
  await page.waitForTimeout(500);
  return info.gpu;
}

async function idleMedian(page: Page, ms: number): Promise<number> {
  await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.startFrames());
  await page.waitForTimeout(ms);
  const samples = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.stopFrames() ?? { ms: [], tags: [] });
  const stats = statsOf(samples);
  expect(stats.idle.frames, 'кадры покоя записаны').toBeGreaterThan(30);
  return stats.idle.p50;
}

test('контроль замера кадра: 4 мс работы в каждом кадре — медиана покоя не меньше 4 мс, без неё — ниже (WebGL и WebGPU)', async ({ browser }) => {
  test.setTimeout(120_000);
  for (const renderer of ['webgl', 'webgpu'] as const) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    const page = await context.newPage();
    const gpu = await openGame(page, renderer);
    const plain = await idleMedian(page, 2000);
    await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.frameWork(4));
    const loaded = await idleMedian(page, 2000);
    await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.frameWork(0));
    const back = await idleMedian(page, 2000);
    console.log(`${renderer} (${gpu}): медиана покоя ${plain.toFixed(2)} мс, с контролем +4 мс — ${loaded.toFixed(2)}, снят — ${back.toFixed(2)}`);
    // Работа контроля целиком между слушателями замера: кадр не короче её (часы — performance.now, шаг 0.1 мс).
    expect(loaded, 'инструмент видит 4 мс работы в кадре').toBeGreaterThanOrEqual(3.9);
    expect(loaded - plain, 'без работы медиана заметно ниже').toBeGreaterThanOrEqual(2);
    expect(loaded - back, 'контроль снят — медиана вернулась').toBeGreaterThanOrEqual(2);
    await context.close();
  }
});

for (const renderer of ['webgl', 'webgpu'] as const) {
  test(`${renderer}: время кадра изнутри кадра — покой, каскад, фича, большой выигрыш; худшее из ${String(RUNS)} прогонов`, async ({ browser }) => {
    test.setTimeout(40 * 60_000);
    const runs: Record<Tag, TagStats>[] = [];
    let gpu = '';
    let atlas = { width: 0, height: 0 };
    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR });
      const page = await context.newPage();
      const { problems } = collectConsole(page);
      gpu = await openGame(page, renderer);
      if (run === 0) atlas = await atlasSize(page);
      await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.startFrames());
      await page.waitForTimeout(3000);
      await playRound(page, 'cascade');
      await playRound(page, 'feature');
      await playRound(page, 'bigWin2');
      await playRound(page, 'maxWin', true);
      const samples = await page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.stopFrames() ?? { ms: [], tags: [] });
      const stats = statsOf(samples);
      for (const tag of FRAME_TAGS) expect(stats[tag].frames, `прогон ${String(run + 1)}: кадры «${tag}» нашлись`).toBeGreaterThan(30);
      runs.push(stats);
      expect(problems, 'консоль пуста').toEqual([]);
      await context.close();
    }
    const worst = worstOf(runs);
    const line = (tag: Tag): string => {
      const s = worst[tag];
      return `${tag}: кадров ≥ ${String(s.frames)}, p50 ${s.p50.toFixed(2)}, p95 ${s.p95.toFixed(2)}, p99 ${s.p99.toFixed(2)}, max ${s.max.toFixed(2)} мс, длиннее 16.7 мс — ${String(s.over60)}`;
    };
    console.log(`${renderer} (${gpu}), ${String(VIEWPORT.width)}×${String(VIEWPORT.height)} DPR ${String(DPR)}, худшее из ${String(RUNS)}:\n  ${FRAME_TAGS.map(line).join('\n  ')}`);
    expect(atlas.width * atlas.height, 'атлас прочитан').toBeGreaterThan(0);
    writeMeasure(`frames-${renderer}`, { renderer, gpu, viewport: VIEWPORT, dpr: DPR, runs: RUNS, worst, perRun: runs, atlas });
  });
}
