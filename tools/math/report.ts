import type { GameConfig } from '../../src/core/model/config.ts';
import { CASCADE_SLOTS } from '../../src/core/engine/index.ts';
import { PAYING_SYMBOL_COUNT } from '../../src/core/model/symbols.ts';
import { BUCKETS, bucketOf } from './buckets.ts';
import { BAND_RATIO, bandRatios } from './shape.ts';
import { MULT_SLOTS, type Batch, type MathPlain } from './stats.ts';

// Отчёт по сборщику. Всё считается из целых: суммы — точно, второй момент — в BigInt; дробные числа — только здесь.
// Поправка книги: книга меняет только вес проигрышей, поэтому любая частота выигрышного события после книги —
// природная × c, где c = 0.96 / RTP природный; второй момент тоже × c.

export const TARGET_RTP = 0.96;
const Z99 = 2.5758293035489;
const SYMBOL_NAMES = ['Кварц', 'Аметист', 'Цитрин', 'Изумруд', 'Сапфир', 'Рубин', 'Бриллиант'];

interface Moments {
  readonly count: number;
  /** Σ payX100. */
  readonly sum: number;
  /** Σ payX100². */
  readonly sum2: bigint;
}

function moments(histogram: Float64Array): Moments {
  let count = 0;
  let sum = 0;
  let sum2 = 0n;
  histogram.forEach((rounds, pay) => {
    if (rounds === 0) return;
    count += rounds;
    sum += pay * rounds;
    sum2 += BigInt(pay) * BigInt(pay) * BigInt(rounds);
  });
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(count)) throw new RangeError('сумма гистограммы вне 2^53');
  return { count, sum, sum2 };
}

/** Наименьшая выплата, у которой накопленная доля раундов не меньше q. */
function quantile(histogram: Float64Array, weightOf: (pay: number, rounds: number) => number, q: number): number {
  let total = 0;
  histogram.forEach((rounds, pay) => (total += weightOf(pay, rounds)));
  let running = 0;
  for (let pay = 0; pay < histogram.length; pay++) {
    running += weightOf(pay, histogram[pay] ?? 0);
    if (running >= q * total) return pay;
  }
  return histogram.length - 1;
}

/** Стандартная ошибка отношения Σx / Σn по пакетам (линеаризация). */
function ratioError(batches: readonly Batch[], x: (batch: Batch) => number, n: (batch: Batch) => number): number {
  if (batches.length < 2) return Number.NaN;
  const ratio = batches.reduce((a, b) => a + x(b), 0) / batches.reduce((a, b) => a + n(b), 0);
  const meanN = batches.reduce((a, b) => a + n(b), 0) / batches.length;
  const variance = batches.reduce((a, b) => a + (x(b) - ratio * n(b)) ** 2, 0) / (batches.length - 1);
  return Math.sqrt(variance / batches.length) / meanN;
}

export interface BookCorrection {
  /** c = 0.96 / RTP природный. */
  readonly factor: number;
  /** Книга возможна, только если после поправки доля выигрышей не больше 1: проигрыши не бывают отрицательными. */
  readonly feasible: boolean;
}

export interface MathReport {
  readonly rounds: number;
  readonly capX100: number;
  readonly rtp: number;
  readonly rtpError: number;
  /** Полуширина 99%-интервала RTP на этой выборке и на 10⁷ раундов. */
  readonly ci99: number;
  readonly ci99At1e7: number;
  readonly sigma: number;
  readonly sigmaBook: number;
  readonly baseRtp: number;
  readonly baseRtpError: number;
  readonly featureRtp: number;
  readonly featureRtpError: number;
  readonly featureShare: number;
  readonly featureShareError: number;
  readonly book: BookCorrection;
  readonly winRate: number;
  readonly overBetRate: number;
  /** Доля выигрышей не больше ставки среди всех выигрышей. */
  readonly smallWinShare: number;
  readonly features: number;
  readonly featureRate: number;
  readonly averageFeatureX: number;
  readonly spinsPerFeature: number;
  readonly retriggerPerSpin: number;
  readonly awards: readonly { readonly spins: number; readonly share: number }[];
  readonly buckets: readonly { readonly label: string; readonly natural: number; readonly book: number; readonly rtp: number }[];
  readonly quantiles: readonly { readonly q: number; readonly natural: number; readonly book: number }[];
  readonly featureQuantiles: readonly { readonly q: number; readonly x: number }[];
  readonly cascades: readonly { readonly phase: 'основная игра' | 'фриспины'; readonly spins: number; readonly byLength: readonly number[] }[];
  readonly maxMult: readonly number[];
  readonly maxLevel: readonly number[];
  readonly caps: number;
  readonly top: { readonly x: number; readonly seed: number };
  readonly longest: { readonly requests: number; readonly seed: number };
  readonly meanRequests: number;
  /** RTP без капа по линейной модели и потеря на капе = без капа − природный. */
  readonly uncappedRtp: number;
  readonly capLoss: number;
  /** Вклад клеток таблицы в RTP без капа: [фаза][символ][полоса]. */
  readonly contribution: readonly (readonly (readonly number[])[])[];
}

export function computeReport(plain: MathPlain, config: GameConfig): MathReport {
  const n = plain.rounds;
  const cap = plain.capX100;
  const total = moments(plain.total);
  const base = moments(plain.base);
  const feature = moments(plain.feature);
  const rtp = total.sum / (100 * n);
  const meanSquare = Number(total.sum2) / (10_000 * n);
  const sigma = Math.sqrt(meanSquare - rtp * rtp);
  const factor = TARGET_RTP / rtp;
  const zeros = plain.total[0] ?? 0;
  const winRate = (n - zeros) / n;
  let overBet = 0;
  plain.total.forEach((rounds, pay) => {
    if (pay > 100) overBet += rounds;
  });
  const bookWeight = (pay: number, rounds: number): number => (pay === 0 ? n - factor * (n - zeros) : rounds * factor);

  const bucketNatural = new Array<number>(BUCKETS.length).fill(0);
  const bucketPay = new Array<number>(BUCKETS.length).fill(0);
  plain.total.forEach((rounds, pay) => {
    if (rounds === 0) return;
    const index = bucketOf(pay, cap);
    bucketNatural[index] = (bucketNatural[index] ?? 0) + rounds;
    bucketPay[index] = (bucketPay[index] ?? 0) + pay * rounds;
  });

  const bands = plain.bands;
  const contribution = [0, 1].map((phase) =>
    Array.from({ length: PAYING_SYMBOL_COUNT }, (_, symbol) =>
      Array.from({ length: bands }, (_, band) => {
        const index = (phase * PAYING_SYMBOL_COUNT + symbol) * bands + band;
        return ((config.paytableX100[symbol]?.[band] ?? 0) * (plain.usage[index] ?? 0)) / (100 * n);
      }),
    ),
  );
  const uncappedRtp = contribution.flat(2).reduce((a, b) => a + b, 0);

  const cascades = (['основная игра', 'фриспины'] as const).map((phase, index) => {
    const byLength = Array.from(plain.cascades.subarray(index * CASCADE_SLOTS, (index + 1) * CASCADE_SLOTS));
    return { phase, spins: byLength.reduce((a, b) => a + b, 0), byLength };
  });

  const qs = [0.5, 0.9, 0.99, 0.999, 0.9999];
  const awards: { spins: number; share: number }[] = [];
  plain.awards.forEach((count, spins) => {
    if (count > 0) awards.push({ spins, share: count / feature.count });
  });

  return {
    rounds: n,
    capX100: cap,
    rtp,
    rtpError: ratioError(plain.batches, (b) => b.payX100 / 100, (b) => b.rounds),
    ci99: (Z99 * sigma) / Math.sqrt(n),
    ci99At1e7: (Z99 * sigma) / Math.sqrt(1e7),
    sigma,
    sigmaBook: Math.sqrt(factor * meanSquare - TARGET_RTP * TARGET_RTP),
    baseRtp: base.sum / (100 * n),
    baseRtpError: ratioError(plain.batches, (b) => b.baseX100 / 100, (b) => b.rounds),
    featureRtp: feature.sum / (100 * n),
    featureRtpError: ratioError(plain.batches, (b) => b.featureX100 / 100, (b) => b.rounds),
    featureShare: feature.sum / total.sum,
    featureShareError: ratioError(plain.batches, (b) => b.featureX100, (b) => b.payX100),
    book: { factor, feasible: factor * winRate <= 1 },
    winRate,
    overBetRate: overBet / n,
    smallWinShare: (n - zeros - overBet) / (n - zeros),
    features: feature.count,
    featureRate: feature.count / n,
    averageFeatureX: feature.count === 0 ? 0 : feature.sum / (100 * feature.count),
    spinsPerFeature: feature.count === 0 ? 0 : plain.freeSpins / feature.count,
    retriggerPerSpin: plain.freeSpins === 0 ? 0 : plain.retriggers / plain.freeSpins,
    awards,
    buckets: BUCKETS.map((bucket, index) => ({
      label: bucket.label,
      natural: (bucketNatural[index] ?? 0) / n,
      book: index === 0 ? 1 - factor * (1 - zeros / n) : ((bucketNatural[index] ?? 0) / n) * factor,
      rtp: (bucketPay[index] ?? 0) / (100 * n),
    })),
    quantiles: qs.map((q) => ({
      q,
      natural: quantile(plain.total, (_pay, rounds) => rounds, q) / 100,
      book: quantile(plain.total, bookWeight, q) / 100,
    })),
    featureQuantiles: qs.map((q) => ({ q, x: quantile(plain.feature, (_pay, rounds) => rounds, q) / 100 })),
    cascades,
    maxMult: Array.from(plain.maxMult, (count) => count / n),
    maxLevel: Array.from(plain.maxLevel, (count) => count / n),
    caps: plain.total[cap] ?? 0,
    top: { x: plain.top.value / 100, seed: plain.top.seed },
    longest: { requests: plain.longest.value, seed: plain.longest.seed },
    meanRequests: plain.requests / n,
    uncappedRtp,
    capLoss: uncappedRtp - rtp,
    contribution,
  };
}

const pct = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;
const oneIn = (rate: number): string => (rate === 0 ? '—' : `1 на ${Math.round(1 / rate).toLocaleString('ru-RU')}`);
const x = (value: number, digits = 2): string => `${value.toFixed(digits)}×`;

/** Параметры прогона, от нагрузки стенда не зависящие: время и скорость в отчёт не попадают. */
export interface RunMeta {
  readonly from: number;
  readonly threads: number;
  readonly taskSize: number;
  readonly maxRequests: number;
}

/** Раздел скорости: его заполняет `npm run math:speed`, проверив нагрузку стенда. */
export const SPEED_OPEN = '<!-- скорость -->';
export const SPEED_CLOSE = '<!-- /скорость -->';
export const SPEED_PENDING = 'Замер не проводился: `npm run math:speed` на свободной машине.';

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

/**
 * Форма таблицы — числа из таблицы конфига: полоса 5–6 и отношения соседних полос (вариант 4, журнал подбора —
 * docs/math-tuning.md).
 */
function shapeNote(config: GameConfig): string {
  const table = config.paytableX100;
  const low = table.map((row) => row[0] ?? Number.NaN);
  const flat = low.every((value) => value === low[0]);
  const { min, max } = bandRatios(table);
  const lowText = flat
    ? `Полоса 5–6 одна на все символы — ${((low[0] ?? Number.NaN) / 100).toFixed(2)}×: кластер из 5–6 платит меньше ставки, строгий пресет его не празднует; при строгом росте по символам и в ней доля фичи и кап выходят за свои полосы (журнал подбора).`
    : `Полоса 5–6 — от ${((low[0] ?? Number.NaN) / 100).toFixed(2)}× до ${((low.at(-1) ?? Number.NaN) / 100).toFixed(2)}×.`;
  return (
    `Форма таблицы (вариант 4): у каждого символа соседние полосы — от ×${min.toFixed(2)} до ×${max.toFixed(2)} ` +
    `(ограничение ×${String(BAND_RATIO.min)}…×${String(BAND_RATIO.max)} — без обрыва между полосами); выше 5–6 символы строго дороже младших. ` +
    lowText
  );
}

export function renderMarkdown(report: MathReport, config: GameConfig, meta: RunMeta): string {
  const r = report;
  const bandLabels = config.sizeBands.map((lower, index) => {
    const next = config.sizeBands[index + 1];
    return next === undefined ? `${String(lower)}+` : `${String(lower)}–${String(next - 1)}`;
  });
  const lines: string[] = [];
  // Каждая часть — отдельный абзац: таблица, прижатая к таблице или тексту, в markdown склеивается.
  const push = (...parts: string[]): void => {
    for (const part of parts) lines.push(part, '');
  };

  push('# Математика Cryscade', '> Сгенерировано `npm run math`. Числа — по симуляции; точные значения после книги — фаза 6.');

  push(
    '## Конфиг',
    table(
      ['', ...SYMBOL_NAMES, 'Ядро'],
      [
        ['веса base', ...config.weights.base.map(String)],
        ['веса free', ...config.weights.free.map(String)],
      ],
    ),
    table(
      ['Символ', ...bandLabels],
      SYMBOL_NAMES.map((name, symbol) => [name, ...(config.paytableX100[symbol] ?? []).map((value) => x(value / 100))]),
    ),
    `Кап ${x(config.capX100 / 100, 0)}; ядра ${config.freeSpinsByScatters.map(String).join(' / ')}; ретриггер ${String(config.retrigger.min)}+ → +${String(config.retrigger.add)}. Самая дорогая клетка — ${x(Math.max(...config.paytableX100.flat()) / 100, 0)} (ограничение — не дороже 1000×: до капа доводят множители и каскады, а не один кластер).`,
    shapeNote(config),
  );

  push(
    '## Прогон',
    `Сиды [${String(meta.from)}, ${String(meta.from + r.rounds)}) — ${r.rounds.toLocaleString('ru-RU')} раундов; потоков ${String(meta.threads)}, задача ${meta.taskSize.toLocaleString('ru-RU')} сидов.`,
  );

  push(
    '## RTP',
    table(
      ['Показатель', 'Значение'],
      [
        ['RTP природный', `${pct(r.rtp, 3)} ± ${pct(r.ci99, 3)} (99%), ошибка по пакетам ${pct(r.rtpError, 3)}`],
        ['Ширина 99%-интервала RTP на 10⁷ раундов', `± ${pct(r.ci99At1e7, 2)} — аргумент за книгу (§5)`],
        ['RTP основной игры', `${pct(r.baseRtp)} ± ${pct(r.baseRtpError)} (ошибка по пакетам)`],
        ['RTP фичи', `${pct(r.featureRtp)} ± ${pct(r.featureRtpError)} (ошибка по пакетам)`],
        ['Доля фичи в RTP', `${pct(r.featureShare, 1)} ± ${pct(r.featureShareError, 1)}`],
        ['σ выигрыша за раунд', `${x(r.sigma)} природная, ${x(r.sigmaBook)} после книги`],
      ],
    ),
  );

  push(
    '## Поправка книги',
    `Книга меняет только вес проигрышей: частоты выигрышных событий после книги = природные × c, c = 0.96 / RTP природный = **${r.book.factor.toFixed(4)}**.` +
      (r.book.feasible ? '' : ' **Книга невозможна: после поправки доля выигрышей больше 1.**'),
    table(
      ['Показатель', 'Природный', 'После книги', 'Цель §4.5'],
      [
        ['Выигрыш', pct(r.winRate), pct(r.winRate * r.book.factor), '25–35%'],
        ['Выигрыш больше ставки', pct(r.overBetRate), pct(r.overBetRate * r.book.factor), '8.5–11.5% (8–12% с запасом 0.5 п.п.)'],
        ['Фича', oneIn(r.featureRate), oneIn(r.featureRate * r.book.factor), '1 на 150–250'],
        ['Кап', oneIn(r.caps / r.rounds), oneIn((r.caps / r.rounds) * r.book.factor), 'от 50 до 200 на 10⁸'],
      ],
    ),
    `Среди выигрышей не больше ставки: ${pct(r.smallWinShare, 1)} — их строгий пресет не празднует.`,
  );

  push(
    '## Фича',
    table(
      ['Показатель', 'Значение'],
      [
        ['Фич', `${r.features.toLocaleString('ru-RU')} (${oneIn(r.featureRate)})`],
        ['Награда', r.awards.map((award) => `${String(award.spins)} — ${pct(award.share, 1)}`).join('; ')],
        ['Спинов на фичу', r.spinsPerFeature.toFixed(2)],
        ['Ретриггер на фриспин', pct(r.retriggerPerSpin, 2)],
        ['Средний выигрыш фичи', x(r.averageFeatureX)],
        ['Квантили выигрыша фичи', r.featureQuantiles.map((item) => `${String(item.q * 100)}% — ${x(item.x)}`).join('; ')],
      ],
    ),
  );

  push(
    '## Корзины §5',
    table(
      ['Корзина', 'Природная доля', 'После книги', 'Вклад в RTP'],
      r.buckets.map((bucket) => [bucket.label, pct(bucket.natural, 4), pct(bucket.book, 4), pct(bucket.rtp, 3)]),
    ),
    table(
      ['Квантиль выигрыша', 'Природный', 'После книги'],
      r.quantiles.map((item) => [`${String(item.q * 100)}%`, x(item.natural), x(item.book)]),
    ),
  );

  push(
    '## Каскады и множители',
    table(
      ['Спины', 'всего', ...Array.from({ length: 8 }, (_, length) => `${String(length)} шагов`), '8+'],
      r.cascades.map((row) => [
        row.phase,
        row.spins.toLocaleString('ru-RU'),
        ...row.byLength.slice(0, 8).map((count) => pct(count / Math.max(row.spins, 1), 3)),
        pct(row.byLength.slice(8).reduce((a, b) => a + b, 0) / Math.max(row.spins, 1), 4),
      ]),
    ),
    table(
      ['Наибольший множитель кластера за раунд', ...Array.from({ length: MULT_SLOTS }, (_, k) => (k === 0 ? 'нет кластера' : `×${String(2 ** (k - 1))}+`))],
      [['доля раундов', ...r.maxMult.map((share) => pct(share, 4))]],
    ),
    table(
      ['Наибольший уровень точки за раунд', ...r.maxLevel.map((_, level) => (level === 0 ? 'нет' : level === 1 ? 'отметка' : `×${String(2 ** (level - 1))}`))],
      [['доля раундов', ...r.maxLevel.map((share) => pct(share, 4))]],
    ),
  );

  push(
    '## Кап и хвост',
    `Кап ${x(r.capX100 / 100, 0)}: ${r.caps.toLocaleString('ru-RU')} раз, ${oneIn(r.caps / r.rounds)} природно, ${pct((r.caps * r.capX100) / (100 * r.rounds), 2)} RTP. Самый крупный выигрыш — ${x(r.top.x)} (сид ${String(r.top.seed)}).`,
    `Выше 1000×: ${pct((r.buckets.slice(-3).reduce((a, b) => a + b.natural, 0)), 5)} раундов. Мало событий в верхних корзинах — это видно по их долям; прогноз хвоста не лучше их числа.`,
  );

  push(
    '## Таблица: вклад клеток в RTP',
    `Линейная модель: выплата раунда без капа = Σ таблица × Σ множителей по клетке. RTP без капа ${pct(r.uncappedRtp, 3)}, потеря на капе ${pct(r.capLoss, 3)}.`,
    ...(['основная игра', 'фича'] as const).map((phase, index) =>
      table(
        [phase, ...bandLabels],
        SYMBOL_NAMES.map((name, symbol) => [name, ...(r.contribution[index]?.[symbol] ?? []).map((value) => pct(value, 3))]),
      ),
    ),
  );

  push(
    '## Сторож и длина раундов',
    `Порог ${meta.maxRequests.toLocaleString('ru-RU')} запросов к источнику за раунд. Самый длинный раунд — ${r.longest.requests.toLocaleString('ru-RU')} (сид ${String(r.longest.seed)}); в среднем ${r.meanRequests.toFixed(1)}.`,
  );

  push('## Пропускная способность', '> Замер стенда, не телефона. Пишет его `npm run math:speed` — только если стенд свободен.', SPEED_OPEN, SPEED_PENDING, SPEED_CLOSE);

  return `${lines.join('\n').trimEnd()}\n`;
}
