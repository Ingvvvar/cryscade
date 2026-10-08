import { SeededEngine, StatsRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import type { Book } from '../../src/server/book.ts';
import { BUCKETS, bucketOf } from '../math/buckets.ts';
import { SIMULATOR_MAX_REQUESTS } from '../math/limits.ts';
import type { MathReport } from '../math/report.ts';

// Отчёт по книге (§5 шаг 5): каждая запись переигрывается движком из сида — итог обязан совпасть с записью, — и все
// показатели — суммы весов в BigInt: частота события = Σ весов записей с событием / W, точно. Дробные числа — только
// в тексте отчёта. Ширина интервала Монте-Карло — из прообраза: книга её и заменяет.

interface BucketFacts {
  readonly label: string;
  readonly records: number;
  readonly weight: bigint;
  readonly paid: bigint;
}

interface BookFacts {
  readonly records: number;
  readonly total: bigint;
  /** Σ веса × payX100 и Σ веса × payX100². */
  readonly paid: bigint;
  readonly paid2: bigint;
  readonly basePaid: bigint;
  readonly featurePaid: bigint;
  readonly wins: bigint;
  readonly overBet: bigint;
  readonly features: bigint;
  readonly caps: bigint;
  readonly freeSpins: bigint;
  readonly retriggers: bigint;
  readonly buckets: readonly BucketFacts[];
  /** Наименьший итог, у которого накопленная доля весов не меньше q. */
  readonly quantiles: readonly { readonly label: string; readonly payX100: number }[];
  /** Индекс и итог последней записи — максимальный выигрыш книги. */
  readonly top: { readonly index: number; readonly payX100: number; readonly seed: number };
}

const QUANTILES: readonly { readonly q: number; readonly label: string }[] = [
  { q: 0.5, label: '50%' },
  { q: 0.9, label: '90%' },
  { q: 0.99, label: '99%' },
  { q: 0.999, label: '99.9%' },
  { q: 0.9999, label: '99.99%' },
];

/** Книга → точные показатели. Запись, чей сид даёт другой итог, — ошибка с индексом. */
export function bookFacts(book: Book, config: GameConfig): BookFacts {
  const recorder = new StatsRecorder(config);
  const engine = new SeededEngine(config, recorder, { maxRequests: SIMULATOR_MAX_REQUESTS });
  let total = 0n;
  let paid = 0n;
  let paid2 = 0n;
  let basePaid = 0n;
  let featurePaid = 0n;
  let wins = 0n;
  let overBet = 0n;
  let features = 0n;
  let caps = 0n;
  let freeSpins = 0n;
  let retriggers = 0n;
  const buckets = BUCKETS.map((bucket) => ({ label: bucket.label, records: 0, weight: 0n, paid: 0n }));
  for (let index = 0; index < book.size; index++) {
    const record = book.record(index);
    const payX100 = engine.play(record.seed);
    if (payX100 !== record.payX100) throw new Error(`запись ${String(index)}: сид ${String(record.seed)} даёт ${String(payX100)}, в книге ${String(record.payX100)}`);
    const w = BigInt(record.weight);
    const pay = BigInt(payX100);
    total += w;
    paid += w * pay;
    paid2 += w * pay * pay;
    basePaid += w * BigInt(recorder.basePayX100);
    featurePaid += w * BigInt(recorder.featurePayX100);
    if (payX100 > 0) wins += w;
    if (payX100 > 100) overBet += w;
    if (recorder.featured) features += w;
    if (recorder.capped) caps += w;
    freeSpins += w * BigInt(recorder.freeSpins);
    retriggers += w * BigInt(recorder.retriggers);
    const bucket = buckets[bucketOf(payX100, config.capX100)];
    if (bucket !== undefined) {
      bucket.records += 1;
      bucket.weight += w;
      bucket.paid += w * pay;
    }
  }
  const quantiles = QUANTILES.map(({ q, label }) => {
    // Записи по возрастанию итога: накопленная доля — по порядку книги.
    const need = (BigInt(Math.round(q * 1e6)) * total + 999_999n) / 1_000_000n;
    let running = 0n;
    for (let index = 0; index < book.size; index++) {
      const record = book.record(index);
      running += BigInt(record.weight);
      if (running >= need) return { label, payX100: record.payX100 };
    }
    return { label, payX100: book.record(book.size - 1).payX100 };
  });
  const last = book.record(book.size - 1);
  return {
    records: book.size,
    total,
    paid,
    paid2,
    basePaid,
    featurePaid,
    wins,
    overBet,
    features,
    caps,
    freeSpins,
    retriggers,
    buckets,
    quantiles,
    top: { index: book.size - 1, payX100: last.payX100, seed: last.seed },
  };
}

/** a / b десятичной дробью с digits знаками после запятой, округление к ближайшему — точно, в BigInt. */
export function decimal(a: bigint, b: bigint, digits: number): string {
  const scale = 10n ** BigInt(digits);
  const scaled = (2n * a * scale + b) / (2n * b);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(digits, '0');
  return digits === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

const percent = (a: bigint, b: bigint, digits = 2): string => `${decimal(100n * a, b, digits)}%`;
const oneIn = (a: bigint, b: bigint): string => (a === 0n ? '—' : `1 на ${Number((2n * b + a) / (2n * a)).toLocaleString('ru-RU')}`);
const times = (x100: number): string => `${(x100 / 100).toFixed(2)}×`;

interface BookMeta {
  readonly file: string;
  readonly sha256: string;
  readonly gzipBytes: number;
  readonly rawBytes: number;
  readonly from: number;
  readonly rounds: number;
  readonly perBucket: number;
  readonly prototype: MathReport;
  readonly prototypeCounts: readonly number[];
}

export function renderBookMarkdown(facts: BookFacts, config: GameConfig, meta: BookMeta): string {
  const f = facts;
  const W = f.total;
  const symbols = ['Кварц', 'Аметист', 'Цитрин', 'Изумруд', 'Сапфир', 'Рубин', 'Бриллиант'];
  const bands = ['5–6', '7–8', '9–10', '11–12', '13–14', '15+'];
  // σ² = E[x²] − E[x]², в ставках; E через точные суммы, корень — в тексте.
  const mean = Number(f.paid) / (100 * Number(W));
  const meanSquare = Number(f.paid2) / (10_000 * Number(W));
  const sigma = Math.sqrt(meanSquare - mean * mean);
  const deviation = f.paid - 96n * W;
  const winsLE = f.wins - f.overBet;
  const lines = [
    '# Математика Cryscade',
    '',
    `> Сгенерировано \`npm run book\`. Числа — по книге исходов, точно: каждая запись переиграна движком из сида (итог совпал с записью), частота события — Σ весов записей с событием / W, суммы — в целых. Отчёт прообраза (симуляция тех же сидов, линейная модель таблицы) — \`docs/math-prototype.md\`.`,
    '',
    '## Конфиг',
    '',
    `|  | ${[...symbols, 'Ядро'].join(' | ')} |`,
    `|${Array.from({ length: 9 }, () => '---').join('|')}|`,
    `| веса base | ${config.weights.base.join(' | ')} |`,
    `| веса free | ${config.weights.free.join(' | ')} |`,
    '',
    `| Символ | ${bands.join(' | ')} |`,
    `|${Array.from({ length: 7 }, () => '---').join('|')}|`,
    ...config.paytableX100.map((row, s) => `| ${symbols[s] ?? ''} | ${row.map(times).join(' | ')} |`),
    '',
    `Кап ${String(config.capX100 / 100)}×; ядра ${config.freeSpinsByScatters.join(' / ')}; ретриггер ${String(config.retrigger.min)}+ → +${String(config.retrigger.add)}.`,
    '',
    '## Книга',
    '',
    '| Показатель | Значение |',
    '|---|---|',
    `| Файл | \`public/books/${meta.file}\` |`,
    `| SHA-256 несжатой книги | \`${meta.sha256}\` |`,
    `| Записей | ${f.records.toLocaleString('ru-RU')} (не больше 80 000) |`,
    `| Размер | ${meta.rawBytes.toLocaleString('ru-RU')} Б, gzip ${meta.gzipBytes.toLocaleString('ru-RU')} Б (не больше 1 МБ) |`,
    `| Сумма весов W | ${W.toLocaleString('ru-RU')} |`,
    `| Прообраз | сиды [${String(meta.from)}, ${String(meta.from + meta.rounds)}), в корзине §5 — до ${String(meta.perBucket)} раундов с наименьшим хешем сида, редкие — все |`,
    '',
    '## RTP',
    '',
    '| Показатель | Значение |',
    '|---|---|',
    `| RTP книги | ${percent(f.paid, 100n * W, 12)} — Σ веса × итог / (100 × W) = ${f.paid.toString()} / ${(100n * W).toString()} |`,
    `| Отклонение от 96% | ${deviation.toString()} / ${(100n * W).toString()} — меньше 1e-9 |`,
    `| RTP основной игры | ${percent(f.basePaid, 100n * W, 3)} |`,
    `| RTP фичи | ${percent(f.featurePaid, 100n * W, 3)} |`,
    `| Доля фичи в RTP | ${percent(f.featurePaid, f.paid, 2)} |`,
    `| σ выигрыша за раунд | ${sigma.toFixed(2)}× |`,
    `| Ширина 99%-интервала RTP на 10⁷ раундов Монте-Карло | ± ${(meta.prototype.ci99At1e7 * 100).toFixed(2)}% (прообраз, σ ${meta.prototype.sigma.toFixed(2)}×) — аргумент за книгу: у неё RTP — точная сумма |`,
    '',
    '## Частоты',
    '',
    '| Показатель | По книге | Цель §4.5 |',
    '|---|---|---|',
    `| Выигрыш | ${percent(f.wins, W)} | 25–35% |`,
    `| Выигрыш больше ставки | ${percent(f.overBet, W)} | 8.5–11.5% (8–12% с запасом 0.5 п.п.) |`,
    `| Фича | ${oneIn(f.features, W)} | 1 на 150–250 |`,
    `| Кап | ${oneIn(f.caps, W)} | от 50 до 200 на 10⁸ |`,
    '',
    `Среди выигрышей не больше ставки: ${percent(winsLE, f.wins, 1)} — их строгий пресет не празднует. Спинов на фичу — ${decimal(f.freeSpins, f.features, 2)}, ретриггер на фриспин — ${percent(f.retriggers, f.freeSpins)}, средний выигрыш фичи — ${decimal(f.featurePaid, 100n * f.features, 2)}×.`,
    '',
    '## Корзины §5',
    '',
    '| Корзина | Записей | Доля в книге | Вклад в RTP | Раундов в прообразе |',
    '|---|---|---|---|---|',
    ...f.buckets.map(
      (bucket, index) =>
        `| ${bucket.label} | ${bucket.records.toLocaleString('ru-RU')} | ${percent(bucket.weight, W, 4)} | ${percent(bucket.paid, 100n * W, 3)} | ${(meta.prototypeCounts[index] ?? 0).toLocaleString('ru-RU')} |`,
    ),
    '',
    '## Хвост',
    '',
    `Верхние корзины прообраз нашёл редко, и книга хранит все их раунды: ${f.buckets
      .filter((bucket, index) => bucket.records === (meta.prototypeCounts[index] ?? -1) && index > 0)
      .map((bucket) => `${bucket.label} — ${String(bucket.records)}`)
      .join('; ')}. Их доли — ровно доли прообраза: прогноз хвоста не лучше числа найденных раундов. Максимальный выигрыш книги — ${times(f.top.payX100)}, запись ${String(f.top.index)} (сид ${String(f.top.seed)}): повтор — \`?replay=book:${String(f.top.index)}\`.`,
    '',
    '| Квантиль выигрыша | По книге |',
    '|---|---|',
    ...f.quantiles.map((item) => `| ${item.label} | ${times(item.payX100)} |`),
    '',
  ];
  return lines.join('\n');
}
