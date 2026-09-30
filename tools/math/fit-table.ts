// Подбор таблицы выплат без обрыва при неизменных весах (вариант 4): node tools/math/fit-table.ts [--rounds=N] [--threads=N]
// Меняется только таблица: веса символов, полосы и движок — варианта 3 (tune.ts). Пишет журнал в docs/math-tuning.md —
// вариант 4 сверху, прежний верх уходит в «Прежние варианты» — и печатает таблицу. Код выхода 3 — не сошлось и с
// ослаблениями: таблица остаётся прежней.
//
// Оценка — по раундам (round-usage.ts): векторы использования таблицы записаны на сидах подбора [2³¹, 2³¹ + N) с
// недостижимым капом, выплата раунда при любой таблице — min(кап, Σ таблица × вектор). Та же линейность RTP по таблице
// и потеря на капе, что в фазе 2, только точно по каждому раунду. Итог сверяется симулятором на тех же сидах.
//
// Ограничения (фаза 2 и новое): у каждого символа соседние полосы — ×1.25…×4; таблица не убывает по полосам и
// символам; значения красивые (ниже 1× шаг 0.05, до 10× — 0.1, дальше — 1×); ни одной клетки ровно 1.00× — доля «выше
// ставки» не должна держаться на округлении в ставку (фаза 2 так отбирала полосу 5–6); выше полосы 5–6 символы строго
// дороже младших. После книги: «выше ставки» 8.5–11.5% (8–12% с запасом 0.5 п.п.), выигрыш 25–35%, фича 1/250–1/150;
// доля фичи 35–41%, ретриггер 1–2%, кап 50–200 на 10⁸, клетка ≤ 1000×, RTP природный 95.5–96.5%. Не сошлось —
// ослабления по одному, накопительно: доля фичи ≤ 45%, клетка ≤ 1500×, «выше ставки» 8.5–14.5%.
//
// Семейства (в полосе символы — геометрически от Кварца к Бриллианту, красиво округлены):
//   «геометрия» — так все шесть полос, символы строго дороже и в 5–6;
//   «плоская 5–6» — полоса 5–6 одна на все символы (0.95×, 0.90×, 0.85×), выше — геометрия.
// Поиск — Нелдер — Мид по логарифмам параметров с фиксированных стартов; штраф — отклонение от целей (доля фичи 38%,
// «выше ставки» 10%, капов 100 на 10⁸, RTP 96%) и выход за полосы.
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { option } from './args.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';
import { computeReport, TARGET_RTP } from './report.ts';
import { UsageTable } from './round-usage.ts';
import { simulate } from './runner.ts';
import { BAND_RATIO, isMonotone, maxCellX100, niceValueX100 } from './shape.ts';
import { recordUsage } from './usage-runner.ts';

const FROM = 2 ** 31;
const ROUNDS = option('rounds', 100_000_000);
const threads = option('threads', os.availableParallelism());
const JOURNAL = 'docs/math-tuning.md';
const HISTORY = '## Прежние варианты';
const CAP = DEFAULT_CONFIG.capX100;
const SYMBOLS = ['Кварц', 'Аметист', 'Цитрин', 'Изумруд', 'Сапфир', 'Рубин', 'Бриллиант'];
const BANDS = ['5–6', '7–8', '9–10', '11–12', '13–14', '15+'];

interface Limits {
  readonly name: string;
  readonly shareMax: number;
  readonly cellMax: number;
  readonly overBetMax: number;
}

const LADDER: readonly Limits[] = [
  { name: 'без ослаблений', shareMax: 0.41, cellMax: 100_000, overBetMax: 0.115 },
  { name: 'доля фичи ≤ 45%', shareMax: 0.45, cellMax: 100_000, overBetMax: 0.115 },
  { name: 'доля фичи ≤ 45%, клетка ≤ 1500×', shareMax: 0.45, cellMax: 150_000, overBetMax: 0.115 },
  { name: 'доля фичи ≤ 45%, клетка ≤ 1500×, «выше ставки» 8.5–14.5%', shareMax: 0.45, cellMax: 150_000, overBetMax: 0.145 },
];

interface Family {
  readonly name: string;
  /** Параметры → таблица в сотых; параметры положительны. */
  table(x: readonly number[]): number[][];
  /** С какой полосы символы строго дороже младших. */
  readonly strictFrom: number;
  readonly starts: readonly (readonly number[])[];
}

/** Символ s полосы — геометрически между Кварцем low и Бриллиантом high, красиво. */
const between = (low: number, high: number, symbol: number): number => niceValueX100(low * (high / low) ** (symbol / 6));

const GEOMETRIC: Family = {
  name: 'геометрия во всех полосах',
  strictFrom: 0,
  table: (x) => SYMBOLS.map((_, s) => BANDS.map((__, b) => between(x[b] ?? 1, x[6 + b] ?? 1, s))),
  starts: [
    [70, 280, 700, 1600, 3000, 4500, 95, 380, 1500, 6000, 15000, 25000],
    [50, 200, 600, 1500, 3000, 6000, 95, 380, 1500, 6000, 20000, 60000],
    [40, 160, 600, 2000, 4000, 6000, 95, 380, 1400, 5000, 14000, 30000],
    [60, 240, 700, 1500, 2500, 4000, 95, 380, 1300, 4500, 12000, 20000],
  ],
};

function flatLow(low: number): Family {
  return {
    name: `плоская 5–6 (${(low / 100).toFixed(2)}×)`,
    strictFrom: 1,
    table: (x) => SYMBOLS.map((_, s) => [low, ...BANDS.slice(1).map((__, i) => between(x[i] ?? 1, x[5 + i] ?? 1, s))]),
    starts: [
      [320, 600, 1700, 3000, 4500, 380, 1500, 6000, 24000, 96000],
      [310, 600, 1900, 3300, 4600, 380, 1500, 6000, 15900, 22500],
      [320, 570, 1400, 2900, 4500, 380, 1400, 5000, 14900, 25300],
      [300, 650, 1500, 2600, 4000, 380, 1520, 6000, 20000, 60000],
    ].map((start) => start.map((value) => Math.min(value, value * (low / 95)))),
  };
}

const FAMILIES: readonly Family[] = [GEOMETRIC, flatLow(95), flatLow(90), flatLow(85)];

function admissible(table: readonly (readonly number[])[], family: Family, limits: Limits): boolean {
  if (!isMonotone(table) || maxCellX100(table) > limits.cellMax) return false;
  for (let s = 0; s < SYMBOLS.length; s++) {
    const row = table[s] ?? [];
    for (let b = 0; b < BANDS.length; b++) {
      const value = row[b] ?? 0;
      if (value < 5 || value === 100 || niceValueX100(value) !== value) return false;
      if (b > 0) {
        const ratio = value / (row[b - 1] ?? 1);
        if (ratio < BAND_RATIO.min || ratio > BAND_RATIO.max) return false;
      }
      if (s > 0 && b >= family.strictFrom && value <= (table[s - 1]?.[b] ?? 0)) return false;
    }
  }
  return true;
}

interface Metrics {
  readonly rtp: number;
  readonly share: number;
  /** Доли после книги: природные × 0.96 / RTP природный. */
  readonly overBet: number;
  readonly win: number;
  readonly feature: number;
  /** Капов на 10⁸ раундов. */
  readonly caps: number;
  readonly cell: number;
}

function metricsOf(usage: UsageTable, table: readonly (readonly number[])[]): Metrics {
  const o = usage.evaluate(table, CAP);
  const rtp = o.payX100 / o.rounds / 100;
  const c = TARGET_RTP / rtp;
  return {
    rtp,
    share: o.featureX100 / o.payX100,
    overBet: (o.overBet / o.rounds) * c,
    win: (o.wins / o.rounds) * c,
    feature: (o.features / o.rounds) * c,
    caps: o.caps * (1e8 / o.rounds),
    cell: maxCellX100(table),
  };
}

/** Какие полосы нарушены (пусто — годна). Ретриггер от таблицы не зависит — его проверяет симулятор. */
function violations(m: Metrics, limits: Limits): string[] {
  const out: string[] = [];
  if (m.share < 0.35 || m.share > limits.shareMax) out.push('доля фичи');
  if (m.overBet < 0.085 || m.overBet > limits.overBetMax) out.push('выше ставки');
  if (m.caps < 50 || m.caps > 200) out.push('кап');
  if (m.rtp < 0.955 || m.rtp > 0.965) out.push('RTP');
  if (m.win < 0.25 || m.win > 0.35) out.push('выигрыш');
  if (m.feature < 1 / 250 || m.feature > 1 / 150) out.push('фича');
  if (m.cell > limits.cellMax) out.push('клетка');
  return out;
}

function penalty(m: Metrics, limits: Limits): number {
  const base = ((m.share - 0.38) / 0.015) ** 2 + ((m.overBet - 0.1) / 0.0075) ** 2 + ((m.rtp - TARGET_RTP) / 0.001) ** 2 + (Math.log2(Math.max(m.caps, 1) / 100) / 0.5) ** 2;
  return base + 100 * violations(m, limits).length;
}

interface Candidate {
  readonly family: Family;
  readonly table: number[][];
  readonly metrics: Metrics;
  readonly penalty: number;
  readonly feasible: boolean;
}

function search(usage: UsageTable, family: Family, limits: Limits, start: readonly number[]): Candidate {
  const n = start.length;
  const score = (logs: readonly number[]): number => {
    const table = family.table(logs.map(Math.exp));
    if (!admissible(table, family, limits)) return 1e6;
    return penalty(metricsOf(usage, table), limits);
  };
  let simplex: number[][] = [start.map(Math.log)];
  for (let i = 0; i < n; i++) simplex.push(start.map((value, j) => Math.log(value) + (i === j ? 0.1 : 0)));
  let values = simplex.map(score);
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      const best = simplex[0] ?? [];
      simplex = [best, ...best.map((_, i) => best.map((value, j) => value + (i === j ? 0.1 : 0)))];
      values = simplex.map(score);
    }
    for (let step = 0; step < 400; step++) {
      const order = values.map((_, i) => i).sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
      simplex = order.map((i) => simplex[i] ?? []);
      values = order.map((i) => values[i] ?? 0);
      const centroid = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((sum, x) => sum + (x[j] ?? 0), 0) / n);
      const worst = simplex[n] ?? [];
      const toward = (t: number): number[] => centroid.map((c, j) => c + t * (c - (worst[j] ?? 0)));
      const reflected = toward(1);
      const fr = score(reflected);
      if (fr < (values[0] ?? 0)) {
        const expanded = toward(2);
        const fe = score(expanded);
        simplex[n] = fe < fr ? expanded : reflected;
        values[n] = Math.min(fe, fr);
      } else if (fr < (values[n - 1] ?? 0)) {
        simplex[n] = reflected;
        values[n] = fr;
      } else {
        const contracted = toward(-0.5);
        const fc = score(contracted);
        if (fc < (values[n] ?? 0)) {
          simplex[n] = contracted;
          values[n] = fc;
        } else {
          const best = simplex[0] ?? [];
          for (let i = 1; i <= n; i++) {
            simplex[i] = (simplex[i] ?? []).map((value, j) => (best[j] ?? 0) + 0.5 * (value - (best[j] ?? 0)));
            values[i] = score(simplex[i] ?? []);
          }
        }
      }
    }
  }
  const at = values.indexOf(Math.min(...values));
  const table = family.table((simplex[at] ?? []).map(Math.exp));
  const metrics = metricsOf(usage, table);
  const ok = admissible(table, family, limits);
  return { family, table, metrics, penalty: ok ? penalty(metrics, limits) : 1e6, feasible: ok && violations(metrics, limits).length === 0 };
}

const pct = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;
const times = (x100: number): string => (x100 / 100).toFixed(2);
const tableMarkdown = (table: readonly (readonly number[])[]): string[] => [
  `| Символ | ${BANDS.join(' | ')} |`,
  `|---|${BANDS.map(() => '---').join('|')}|`,
  ...table.map((row, s) => `| ${SYMBOLS[s] ?? ''} | ${row.map(times).join(' | ')} |`),
];
const row = (label: string, c: Candidate): string =>
  `| ${label} | ${c.family.name} | ${pct(c.metrics.rtp, 3)} | ${pct(c.metrics.share)} | ${pct(c.metrics.overBet)} | ${c.metrics.caps.toFixed(0)} | ${times(c.metrics.cell)}× | ${c.penalty >= 1e6 ? '—' : c.penalty.toFixed(2)} | ${c.feasible ? '✓' : '✗'} |`;

const started = performance.now();
const usage = new UsageTable(
  await recordUsage({ config: DEFAULT_CONFIG, from: FROM, rounds: ROUNDS, taskSize: 100_000, maxRequests: SIMULATOR_MAX_REQUESTS }, threads),
);
console.log(`векторы: ${ROUNDS.toLocaleString('ru-RU')} раундов за ${((performance.now() - started) / 1000).toFixed(0)} с`);
const previousTable = DEFAULT_CONFIG.paytableX100.map((values) => [...values]);
const previous = metricsOf(usage, previousTable);

const log: string[] = [];
let chosen: Candidate | null = null;
let level: Limits | null = null;
for (const limits of LADDER) {
  const candidates: Candidate[] = [];
  for (const family of FAMILIES) {
    family.starts.forEach((start, index) => {
      const candidate = search(usage, family, limits, start);
      candidates.push(candidate);
      const line = row(`${limits.name}, старт ${String(index + 1)}`, candidate);
      log.push(line);
      console.log(line);
    });
  }
  const feasible = candidates.filter((c) => c.feasible).sort((a, b) => a.penalty - b.penalty);
  if (feasible.length > 0) {
    chosen = feasible[0] ?? null;
    level = limits;
    break;
  }
}

// Сверка: симулятор с выбранной таблицей на тех же сидах — оценка по векторам обязана совпасть до единицы.
const finalTable = chosen?.table ?? previousTable;
const config = { ...DEFAULT_CONFIG, paytableX100: finalTable };
const plain = await simulate({ config, from: FROM, rounds: ROUNDS, taskSize: 100_000, maxRequests: SIMULATOR_MAX_REQUESTS }, threads);
const report = computeReport(plain, config);
const evaluated = usage.evaluate(finalTable, CAP);
const paid = plain.batches.reduce((sum, batch) => sum + batch.payX100, 0);
const overBet = plain.batches.reduce((sum, batch) => sum + batch.overBet, 0);
if (paid !== evaluated.payX100 || overBet !== evaluated.overBet || report.caps !== evaluated.caps) {
  throw new Error(`оценка по векторам разошлась с симулятором: ${String(evaluated.payX100)} и ${String(paid)}`);
}
const c = TARGET_RTP / report.rtp;
const checks: [string, string, string, boolean][] = [
  ['выигрыш после книги', pct(report.winRate * c), '25–35%', report.winRate * c >= 0.25 && report.winRate * c <= 0.35],
  ['фича после книги', `1/${Math.round(1 / (report.featureRate * c)).toString()}`, '1/250–1/150', report.featureRate * c >= 1 / 250 && report.featureRate * c <= 1 / 150],
  ['выше ставки после книги', pct(report.overBetRate * c), level === null ? '8.5–11.5%' : `8.5–${pct(level.overBetMax, 1)}`, report.overBetRate * c >= 0.085 && report.overBetRate * c <= (level?.overBetMax ?? 0.115)],
  ['доля фичи', pct(report.featureShare), level === null ? '35–41%' : `35–${pct(level.shareMax, 0)}`, report.featureShare >= 0.35 && report.featureShare <= (level?.shareMax ?? 0.41)],
  ['ретриггер на фриспин', pct(report.retriggerPerSpin), '1–2%', report.retriggerPerSpin >= 0.01 && report.retriggerPerSpin <= 0.02],
  ['кап на 10⁸', String(Math.round(report.caps * (1e8 / report.rounds))), '50–200', report.caps * (1e8 / report.rounds) >= 50 && report.caps * (1e8 / report.rounds) <= 200],
  ['самая дорогая клетка', `${times(maxCellX100(finalTable))}×`, level === null ? '≤ 1000×' : `≤ ${String(level.cellMax / 100)}×`, maxCellX100(finalTable) <= (level?.cellMax ?? 100_000)],
];

const history = (() => {
  try {
    const text = readFileSync(JOURNAL, 'utf8');
    const top = text.indexOf('\n## ');
    const at = text.indexOf(HISTORY);
    if (top < 0 || at < 0) return '';
    // Прежний верх (вариант 3) — первым в «Прежние варианты», его заголовки — на уровень ниже.
    const demoted = text
      .slice(top + 1, at)
      .trimEnd()
      .replace(/^(#{2,}) /gm, '#$1 ');
    return [HISTORY, '', demoted, '', text.slice(at + HISTORY.length).trim()].join('\n');
  } catch {
    return '';
  }
})();

const lines = [
  '# Подбор математики — журнал',
  '',
  '> Сгенерировано `node tools/math/fit-table.ts` (вариант 4, таблица) поверх `node tools/math/tune.ts` (вариант 3, веса). Итоговые числа — в `docs/math.md` (сиды [0, 10⁸)).',
  '',
  '## Вариант 4 — таблица без обрыва',
  '',
  'Меняется только таблица: веса символов, полосы и движок — варианта 3. Причина — обрыв варианта 3 между полосами 5–6 и 7–8: у Кварца 0.30× → 3.80×, в 12.7 раза, у Бриллианта 1.50× → 24×, в 16. Новое ограничение: у каждого символа соседние полосы — от ×1.25 до ×4. Остальное — как в фазе 2: цели §4.5, «выше ставки» после книги 8.5–11.5% (8–12% с запасом 0.5 п.п.), доля фичи 35–41%, ретриггер 1–2%, кап 50–200 на 10⁸, клетка ≤ 1000×, таблица не убывает по полосам и символам, красивое округление, ни одной клетки ровно 1.00× (доля «выше ставки» не должна держаться на округлении в ставку). Выше полосы 5–6 символы строго дороже младших.',
  '',
  `Оценка — точная по раундам: на сидах подбора [2³¹, 2³¹ + ${ROUNDS.toLocaleString('ru-RU')}) записаны векторы использования таблицы (клетка → сумма множителей её кластеров) с недостижимым капом; выплата раунда при любой таблице — min(5000×, Σ таблица × вектор). Это линейность RTP по таблице и потеря на капе фазы 2, только по каждому раунду. Итог сверен симулятором на тех же сидах — совпал до сотой доли ставки.`,
  '',
  `Прежняя таблица (вариант 3) на этих сидах: RTP ${pct(previous.rtp, 3)}, доля фичи ${pct(previous.share)}, «выше ставки» после книги ${pct(previous.overBet)}, капов ${previous.caps.toFixed(0)} на 10⁸.`,
  '',
  'Семейства: в каждой полосе символы — геометрически от Кварца к Бриллианту, красиво округлены. «Геометрия во всех полосах» — так и полоса 5–6; «плоская 5–6» — полоса 5–6 одна на все символы. Поиск — Нелдер — Мид по логарифмам значений Кварца и Бриллианта в полосах с четырёх стартов на семейство; штраф — отклонение от целей (доля фичи 38%, «выше ставки» 10%, капов 100 на 10⁸, RTP 96%) и выход за полосы. Не сходится — ослабления по одному, накопительно: доля фичи ≤ 45%, клетка ≤ 1500×, «выше ставки» 8.5–14.5%.',
  '',
  '| Ступень, старт | Семейство | RTP | Доля фичи | Выше ставки | Капов на 10⁸ | Клетка | Штраф | Годна |',
  '|---|---|---|---|---|---|---|---|---|',
  ...log,
  '',
  chosen === null
    ? '**Не сошлось и со всеми ослаблениями — таблица остаётся прежней.**'
    : `Взята годная с наименьшим штрафом: ${chosen.family.name}; ослабление — ${level?.name ?? '—'}.`,
  '',
  '### Ограничения',
  '',
  '| Показатель | Итог на сидах подбора | Полоса | |',
  '|---|---|---|---|',
  ...checks.map(([name, value, band, ok]) => `| ${name} | ${value} | ${band} | ${ok ? '✓' : '✗'} |`),
  '',
  `RTP на сидах подбора ${pct(report.rtp, 3)} ± ${pct(report.ci99, 3)} (99%), основа ${pct(report.baseRtp)}, фича ${pct(report.featureRtp)}.`,
  '',
  '### Итог',
  '',
  ...tableMarkdown(finalTable),
  '',
  '```ts',
  `paytableX100: [${finalTable.map((values) => `[${values.join(', ')}]`).join(', ')}],`,
  '```',
  '',
  history,
  '',
];
writeFileSync(JOURNAL, lines.join('\n'));
console.log(tableMarkdown(finalTable).join('\n'));
console.log(checks.map(([name, value, band, ok]) => `${ok ? '✓' : '✗'} ${name}: ${value} (${band})`).join('\n'));
if (chosen === null) {
  console.log('СТОП: не сошлось и со всеми ослаблениями — таблица прежняя');
  process.exitCode = 3;
} else if (checks.some(([, , , ok]) => !ok)) {
  console.log('СТОП: симулятор нашёл ограничение вне полосы');
  process.exitCode = 3;
}
