import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { ShownRound } from '../../src/client/index.ts';
import type { StillOptions } from '../../src/ui/probe-api.ts';
import { FORCED_SEEDS } from '../../src/ui/forced-rounds.ts';
import type { ProbeWindow } from '../support/page-probe.ts';
import { fixtureShown, seedShown } from '../support/shown-rounds.ts';
import { openStill, snapshot } from './support/frame.ts';

// Скриншоты ключевых моментов показа (фаза 5, решения 9 и 14) — владельцу на глаз, в reports/phase-5/ с индексом
// «что смотреть». Поддельные часы Playwright, декор закреплён, показ стоит на моменте t (зонд still): кадр
// детерминирован. Ландшафт WebGL — все моменты; портрет и WebGPU — подсветка и большой выигрыш. Каждый снимок подписан
// фактическим рендерером; на программном рендере не снимаем.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = `${ROOT}reports/phase-5/`;

interface Moment {
  readonly file: string;
  readonly title: string;
  /** Что смотреть на снимке. */
  readonly look: string;
  readonly round: ShownRound;
  /** Сегмент и доля его хода; which — первый или последний такой сегмент раунда. */
  readonly segment: string;
  readonly share: number;
  readonly which: 'first' | 'last';
  readonly options?: StillOptions;
  /** Снимать ещё в портрете и на WebGPU. */
  readonly everywhere?: boolean;
}

const MOMENTS: readonly Moment[] = [
  {
    file: 'fall',
    title: 'Падение',
    look: 'колонки падают слева направо с задержкой, край сетки проявляет символы без маски',
    round: fixtureShown('loss'),
    segment: 'fall',
    share: 0.35,
    which: 'first',
  },
  {
    file: 'highlight',
    title: 'Подсветка с контуром — обычная подложка',
    look: 'свечение glow-* (решение 9: оценить силу и ширину ореола), контур кластера по границам клеток со срезом углов',
    round: fixtureShown('multiplier-8'),
    segment: 'highlight',
    share: 0.6,
    which: 'first',
    everywhere: true,
  },
  {
    file: 'highlight-multiplier',
    title: 'Подсветка на подложках множителей',
    look: 'свечение над клетками с ×N: читается ли число на плашке и цвет кромки уровня под ореолом',
    round: fixtureShown('multiplier-8'),
    segment: 'highlight',
    share: 0.6,
    which: 'last',
  },
  {
    file: 'explode',
    title: 'Взрыв с осколками',
    look: 'осколки атласа разлетаются, вспышка-звезда, символы растут и гаснут, контур уходит',
    round: fixtureShown('multiplier-8'),
    segment: 'explode',
    share: 0.35,
    which: 'first',
  },
  {
    file: 'spots',
    title: 'Точки множителей ×8',
    look: 'кромки цвета уровня вокруг тёмной подложки, плашки ×2…×8 у нижнего края, всплеск новой точки',
    round: fixtureShown('multiplier-8'),
    segment: 'spots',
    share: 0.5,
    which: 'last',
  },
  {
    file: 'counter',
    title: 'Счётчик на середине подсчёта',
    look: 'число в зоне выигрыша растёт от 0 к итогу 16,35 (кривая замедляется к концу), разделитель — запятая',
    round: fixtureShown('multiplier-8'),
    segment: 'tally',
    share: 0.5,
    which: 'first',
  },
  {
    file: 'feature',
    title: 'Вход в фичу: плашка featureIntro',
    look: 'плашка «Фріспіни 10» и подсказка — показ ждёт тапа или пробела; ядра подсвечены',
    round: fixtureShown('feature-start'),
    segment: 'plaqueOut',
    share: 0,
    which: 'first',
  },
  {
    file: 'free-spins',
    title: 'Фриспины',
    look: 'тёплый грот, рамка ярче, счётчик фриспинов слева, замок в плашках множителей',
    round: fixtureShown('feature-start'),
    segment: 'highlight',
    share: 0.6,
    which: 'last',
  },
  {
    file: 'big-win-1',
    title: 'Большой выигрыш: «Великий» (25.85×)',
    look: 'затемнение, надпись уровня, сумма досчитывается',
    round: seedShown(FORCED_SEEDS.bigWin1),
    segment: 'celebrate',
    share: 0.5,
    which: 'first',
  },
  {
    file: 'big-win-2',
    title: 'Большой выигрыш: «Величезний» (57×)',
    look: 'то же, уровень 2',
    round: seedShown(FORCED_SEEDS.bigWin2),
    segment: 'celebrate',
    share: 0.5,
    which: 'first',
  },
  {
    file: 'big-win-3',
    title: 'Большой выигрыш: «Епічний» (132.85×)',
    look: 'то же, уровень 3',
    round: seedShown(FORCED_SEEDS.bigWin3),
    segment: 'celebrate',
    share: 0.5,
    which: 'first',
  },
  {
    file: 'big-win-4',
    title: 'Большой выигрыш: «Максимальний» (кап 5000×)',
    look: 'то же, уровень 4 — самый долгий',
    round: fixtureShown('biggest'),
    segment: 'celebrate',
    share: 0.5,
    which: 'first',
    everywhere: true,
  },
  {
    file: 'strict',
    title: 'Строгий пресет: выигрыш 0.35× ≤ ставки без празднования',
    look: 'подсветка — только контур, без свечения; подсчёт мгновенный (на следующих кадрах — сразу итог)',
    round: fixtureShown('small-win'),
    segment: 'highlight',
    share: 0.6,
    which: 'first',
    options: { strict: true },
  },
  {
    file: 'reduced-motion',
    title: 'Reduced motion: взрыв без осколков',
    look: 'символы гаснут без разлёта осколков и вспышек, фон стоит',
    round: fixtureShown('multiplier-8'),
    segment: 'explode',
    share: 0.35,
    which: 'first',
    options: { reducedMotion: true },
  },
];

interface Shot {
  readonly file: string;
  readonly title: string;
  readonly look: string;
  readonly renderer: string;
  readonly gpu: string;
  readonly frame: string;
  readonly t: number;
}

const shots: Shot[] = [];

const FRAMES = {
  landscape: { viewport: { width: 1440, height: 900 }, dpr: 2 },
  portrait: { viewport: { width: 390, height: 844 }, dpr: 3 },
} as const;

/** Показ стоит на доле share сегмента segment раунда; вернёт t. */
async function standAt(page: Page, moment: Moment): Promise<number> {
  const t = await page.evaluate(({ round, segment, share, which, options }) => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    if (probe === undefined) throw new Error('нет зонда');
    probe.still(round, 0, options);
    const found = (probe.schedule()?.segments ?? []).filter((item) => item.kind === segment);
    const target = which === 'first' ? found[0] : found.at(-1);
    if (target === undefined) return -1;
    const at = Math.floor(target.startMs + (target.endMs - target.startMs) * share);
    probe.still(round, at, options);
    return at;
  }, { round: moment.round, segment: moment.segment, share: moment.share, which: moment.which, options: moment.options ?? {} });
  expect(t, `${moment.file}: сегмент ${moment.segment} есть в расписании`).toBeGreaterThanOrEqual(0);
  return t;
}

async function shoot(browser: Browser, renderer: 'webgl' | 'webgpu', frame: keyof typeof FRAMES, moments: readonly Moment[]): Promise<void> {
  const { viewport, dpr } = FRAMES[frame];
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const info = await openStill(page, `?renderer=${renderer}`);
  expect(info.name, 'фактический рендерер').toBe(renderer);
  expect(info.software, `программный рендер: ${info.gpu}`).toBe(false);
  for (const moment of moments) {
    const t = await standAt(page, moment);
    // Кадр ставит тикер: часы страницы идут, показ стоит на t; тепло фриспинов успевает набраться.
    await page.clock.runFor(1000);
    const { png } = await snapshot(page);
    const file = `${moment.file}-${frame}-${renderer}.png`;
    writeFileSync(`${OUT}${file}`, png);
    shots.push({ file, title: moment.title, look: moment.look, renderer: info.name, gpu: info.gpu, frame, t });
  }
  await context.close();
}

mkdirSync(OUT, { recursive: true });

test('ландшафт, WebGL: все ключевые моменты', async ({ browser }) => {
  test.setTimeout(120_000);
  await shoot(browser, 'webgl', 'landscape', MOMENTS);
});

test('портрет, WebGL: подсветка и большой выигрыш', async ({ browser }) => {
  await shoot(browser, 'webgl', 'portrait', MOMENTS.filter((moment) => moment.everywhere === true));
});

test('ландшафт, WebGPU: подсветка и большой выигрыш', async ({ browser }) => {
  await shoot(browser, 'webgpu', 'landscape', MOMENTS.filter((moment) => moment.everywhere === true));
});

test.afterAll(() => {
  const rows = shots.map((shot) => `| [${shot.file}](${shot.file}) | ${shot.title} | ${shot.look} | ${shot.renderer}, t = ${String(shot.t)} мс |`);
  const index = [
    '# Фаза 5 — ключевые моменты показа: что смотреть',
    '',
    'Поддельные часы Playwright, декор закреплён, показ стоит на моменте t (зонд `still`). Снимки — `npm run shots`.',
    `GPU: ${shots[0]?.gpu ?? '—'}.`,
    '',
    '| Снимок | Момент | Что смотреть | Рендерер |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Числа множителей на плашках и читаемость символов на подложках множителей: `multipliers-*.png`, `multipliers-*.json`',
    '(тест `tests/gpu/presentation.spec.ts`).',
    '',
  ].join('\n');
  writeFileSync(`${OUT}index.md`, index);
});
