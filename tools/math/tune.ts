// Подбор весов и таблицы под цели §4.5: node tools/math/tune.ts [--threads=N]
// Пишет журнал в docs/math-tuning.md (раздел «Прежние варианты» сохраняется) и печатает итоговый конфиг.
// Сиды подбора — от 2³¹, общие для всех кандидатов: сравнение соседних кандидатов почти не шумит.
// Итоговый отчёт — на других сидах, [0, 10⁸) (npm run math). Код выхода 3 — ограничение не выполнено: стоп.
//
// Стадии:
//   1. r_b и s_b — частота выигрыша 30% и фича 1/200 (2·10⁶ раундов на оценку); от таблицы не зависят.
//   2. m — множитель полосы 5–6 — и сразу красивая таблица: черновик × k(m), полоса 5–6 — ещё × m; k(m) держит RTP
//      основы 59.5% = 96% × 62% по линейности таблицы (использование стадии 1), но не выше предела клетки ≤ 1000×.
//      Сетка по m; для каждой новой красивой таблицы доля «выше ставки» — симуляцией (2·10⁶). Годится таблица с долей
//      в 9–11% (0.5 п.п. запаса внутри 8.5–11.5%) и без клетки полосы 5–6 ровно в 1.00×: доля не должна держаться на
//      одном округлении в ставку. Из годных — с прогнозом RTP основы ближе к цели.
//   s_f — ретриггер 1.5% на фриспин, до стадии 3.
//   3. r_f — RTP фичи 36.5% = 96% × 38%, природный, с капом (10⁷ раундов на оценку).
//   4. Остаток до природного RTP с капом 96% добирает r_f (бисекция в узком окне, 10⁷): таблица уже красивая.
//   5. Ограничения: выигрыш 25–35%, фича 1/250–1/150, «выше ставки» 8.5–11.5% — после книги; доля фичи 35–41%,
//      ретриггер 1–2%, клетка ≤ 1000×, кап 5–20 на 10⁷ (грубо; итог по капу, 50–200 на 10⁸, — отчёт).
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import { option } from './args.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';
import { computeReport, TARGET_RTP, type MathReport } from './report.ts';
import { simulate } from './runner.ts';
import { DRAFT_PAYTABLE_X100, MAX_CELL_X100, geometricWeights, isMonotone, maxCellX100, niceTable, scaledTable } from './shape.ts';
import type { MathPlain } from './stats.ts';

const FROM = 2 ** 31;
const SHORT = 2_000_000;
const LONG = 10_000_000;
const JOURNAL = 'docs/math-tuning.md';
const HISTORY = '## Прежние варианты';
const threads = option('threads', os.availableParallelism());

const TARGET = { win: 0.3, feature: 1 / 200, overBet: 0.1, baseRtp: 0.96 * 0.62, featureRtp: 0.96 * 0.38, retrigger: 0.015, rtp: TARGET_RTP };

interface Params {
  readonly rb: number;
  readonly sb: number;
  readonly rf: number;
  readonly sf: number;
  /** Множитель полосы 5–6. */
  readonly low: number;
  readonly table: readonly (readonly number[])[];
}

interface Evaluation {
  readonly params: Params;
  readonly report: MathReport;
  readonly plain: MathPlain;
}

function configOf(params: Params): GameConfig {
  return {
    ...DEFAULT_CONFIG,
    weights: { base: geometricWeights(params.rb, params.sb), free: geometricWeights(params.rf, params.sf) },
    paytableX100: params.table,
  };
}

const log: string[] = [];
const pct = (value: number, digits = 2): string => `${(value * 100).toFixed(digits)}%`;

function row(stage: string, evaluation: Evaluation, rounds: number): string {
  const { params, report: r } = evaluation;
  const cells = [
    stage,
    params.rb.toFixed(4),
    String(params.sb),
    params.rf.toFixed(4),
    String(params.sf),
    params.low.toFixed(4),
    `${(rounds / 1e6).toFixed(0)}M`,
    pct(r.winRate),
    pct(r.overBetRate),
    `1/${Math.round(1 / r.featureRate).toString()}`,
    pct(r.retriggerPerSpin),
    `${pct(r.baseRtp)} ± ${pct(r.baseRtpError)}`,
    `${pct(r.featureRtp)} ± ${pct(r.featureRtpError)}`,
    `${pct(r.rtp)} ± ${pct(r.rtpError)}`,
    String(r.caps),
  ];
  return `| ${cells.join(' | ')} |`;
}

async function evaluate(stage: string, params: Params, rounds: number): Promise<Evaluation> {
  const config = configOf(params);
  const plain = await simulate({ config, from: FROM, rounds, taskSize: 100_000, maxRequests: SIMULATOR_MAX_REQUESTS }, threads);
  const evaluation = { params, report: computeReport(plain, config), plain };
  const line = row(stage, evaluation, rounds);
  log.push(line);
  console.log(line);
  return evaluation;
}

/**
 * Бисекция по монотонному показателю: сужает отрезок к цели и возвращает ближайшую к цели из посчитанных оценок.
 * Для целых — пока отрезок длиннее 1.
 */
async function bisect(
  lo: number,
  hi: number,
  target: number,
  steps: number,
  integer: boolean,
  increasing: boolean,
  measure: (x: number) => Promise<Evaluation>,
  metric: (evaluation: Evaluation) => number,
): Promise<Evaluation> {
  let best: Evaluation | null = null;
  let left = lo;
  let right = hi;
  for (let step = 0; step < steps && (!integer || right - left > 1); step++) {
    const mid = integer ? Math.floor((left + right) / 2) : (left + right) / 2;
    const evaluation = await measure(mid);
    const value = metric(evaluation);
    if (best === null || Math.abs(value - target) < Math.abs(metric(best) - target)) best = evaluation;
    if (value < target === increasing) left = mid;
    else right = mid;
  }
  if (best === null) throw new Error('бисекция без оценок');
  return best;
}

/** RTP по использованию таблицы: без капа — линейно по фазам, потеря на капе — из раундов, упёршихся в кап. */
function predict(plain: MathPlain, table: readonly (readonly number[])[]): { rtp: number; base: number; feature: number } {
  const bands = plain.bands;
  let base = 0;
  let feature = 0;
  plain.usage.forEach((mult, index) => {
    const band = index % bands;
    const symbol = Math.floor(index / bands) % 7;
    const phase = Math.floor(index / (7 * bands));
    const paid = (table[symbol]?.[band] ?? Number.NaN) * (mult - (plain.usageCapped[index] ?? 0));
    if (phase === 0) base += paid;
    else feature += paid;
  });
  const capped = (plain.total[plain.capX100] ?? 0) * plain.capX100;
  const n = 100 * plain.rounds;
  return { rtp: (base + feature + capped) / n, base: base / n, feature: feature / n };
}

const header =
  '| Стадия | r_b | s_b | r_f | s_f | m (5–6) | Раундов | Выигрыш | Выше ставки | Фича | Ретриггер | RTP основы | RTP фичи | RTP | Капов |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
console.log(header);

// Стадия 1: форма основной игры на черновике. Фриспины — равные веса: на частоту выигрыша и фичи они не влияют.
let params: Params = { rb: 0.92, sb: 70, rf: 1, sf: 70, low: 1, table: DRAFT_PAYTABLE_X100 };
let stage1: Evaluation | null = null;
for (let round = 1; round <= 2; round++) {
  const byWin = await bisect(0.8, 1, TARGET.win, 7, false, false, (rb) => evaluate(`1.${String(round)} r_b`, { ...params, rb }, SHORT), (e) => e.report.winRate);
  params = { ...params, rb: byWin.params.rb };
  stage1 = await bisect(30, 110, TARGET.feature, 8, true, true, (sb) => evaluate(`1.${String(round)} s_b`, { ...params, sb }, SHORT), (e) => e.report.featureRate);
  params = { ...params, sb: stage1.params.sb };
}
if (stage1 === null) throw new Error('стадия 1 без итога');
const baseUsage = stage1.plain;

// Стадия 2: сетка по m; k(m) — по линейности RTP основы на черновике (кап в основе при k = 1 не бывает), но не выше
// предела клетки: самая дорогая клетка черновика × k ≤ 1000×. Долю «выше ставки» меряем на той таблице, что пойдёт в игру.
const kCeiling = MAX_CELL_X100 / maxCellX100(DRAFT_PAYTABLE_X100);
function scaleFor(low: number): number {
  return Math.min(kCeiling, TARGET.baseRtp / predict(baseUsage, scaledTable(1, low)).base);
}
params = { ...params, rf: 0.85, sf: 95 };
interface LowCandidate {
  readonly low: number;
  readonly k: number;
  readonly table: number[][];
  readonly base: number;
  readonly overBet: number;
  readonly exactBet: boolean;
}
const lowCandidates: LowCandidate[] = [];
const seenTables = new Set<string>();
for (let step = 0; step <= 50; step++) {
  const low = 0.1 + step * 0.002;
  const k = scaleFor(low);
  const table = niceTable(k, low);
  const key = JSON.stringify(table);
  if (seenTables.has(key) || !isMonotone(table) || maxCellX100(table) > MAX_CELL_X100) continue;
  seenTables.add(key);
  const check = await evaluate('2 m', { ...params, low, table }, SHORT);
  lowCandidates.push({
    low,
    k,
    table,
    base: predict(baseUsage, table).base,
    overBet: check.report.overBetRate,
    exactBet: table.some((row) => row[0] === 100),
  });
}
const eligible = lowCandidates.filter((c) => c.overBet >= 0.09 && c.overBet <= 0.11 && !c.exactBet);
const pickedLow = eligible.reduce<LowCandidate | null>(
  (best, c) => (best === null || Math.abs(c.base - TARGET.baseRtp) < Math.abs(best.base - TARGET.baseRtp) ? c : best),
  null,
);
if (pickedLow === null) {
  console.log('СТОП: на сетке m нет красивой таблицы с «выше ставки» в 9–11% без клетки ровно в 1.00×');
  for (const c of lowCandidates) console.log(`m ${c.low.toFixed(3)} k ${c.k.toFixed(3)}: выше ставки ${pct(c.overBet)}, основа ${pct(c.base)}${c.exactBet ? ', клетка ровно 1×' : ''}`);
  process.exit(3);
}
const low = pickedLow.low;
const k2 = pickedLow.k;
params = { ...params, low, table: pickedLow.table };
console.log(`стадия 2: m = ${low.toFixed(4)}, k = ${k2.toFixed(4)}${k2 >= kCeiling ? ' — упёрлось в предел клетки' : ''}, выше ставки ${pct(pickedLow.overBet)}`);

// s_f — до стадии 3: ретриггер 1.5% на фриспин при пробном r_f.
const bySf = await bisect(10, 300, TARGET.retrigger, 9, true, true, (sf) => evaluate('s_f', { ...params, sf }, SHORT), (e) => e.report.retriggerPerSpin);
params = { ...params, sf: bySf.params.sf };

// Стадия 3: r_f — RTP фичи, природный, с капом. Чем меньше r_f, тем богаче фича.
let stage3 = await bisect(0.65, 0.95, TARGET.featureRtp, 9, false, false, (rf) => evaluate('3 r_f', { ...params, rf }, LONG), (e) => e.report.featureRtp);
params = { ...params, rf: stage3.params.rf };
if (stage3.report.retriggerPerSpin < 0.01 || stage3.report.retriggerPerSpin > 0.02) {
  console.log(`ретриггер ${pct(stage3.report.retriggerPerSpin)} вне 1–2% — s_f заново при r_f ${params.rf.toFixed(4)}`);
  const again = await bisect(10, 300, TARGET.retrigger, 9, true, true, (sf) => evaluate('s_f′', { ...params, sf }, SHORT), (e) => e.report.retriggerPerSpin);
  params = { ...params, sf: again.params.sf };
  stage3 = await bisect(0.65, 0.95, TARGET.featureRtp, 9, false, false, (rf) => evaluate('3′ r_f', { ...params, rf }, LONG), (e) => e.report.featureRtp);
  params = { ...params, rf: stage3.params.rf };
}

// Стадия 4: таблица уже красивая; остаток до природного RTP с капом 96% добирает r_f.
const predicted = predict(stage3.plain, params.table);
console.log(`стадия 4: прогноз по использованию стадии 3 — RTP ${pct(predicted.rtp, 3)}, основа ${pct(predicted.base)}`);
const final = await bisect(params.rf - 0.01, params.rf + 0.01, TARGET.rtp, 7, false, false, (rf) => evaluate('4 r_f', { ...params, rf }, LONG), (e) => e.report.rtp);
params = final.params;
const config = configOf(params);

// Стадия 5: ограничения. Частоты после книги — природные × 0.96 / RTP природный.
const r = final.report;
const c = TARGET_RTP / r.rtp;
const checks: [string, number, string, boolean][] = [
  ['выигрыш после книги', r.winRate * c, '25–35%', r.winRate * c >= 0.25 && r.winRate * c <= 0.35],
  ['фича после книги', r.featureRate * c, '1/250–1/150', r.featureRate * c >= 1 / 250 && r.featureRate * c <= 1 / 150],
  ['выше ставки после книги', r.overBetRate * c, '8.5–11.5%', r.overBetRate * c >= 0.085 && r.overBetRate * c <= 0.115],
  ['доля фичи', r.featureShare, '35–41%', r.featureShare >= 0.35 && r.featureShare <= 0.41],
  ['ретриггер на фриспин', r.retriggerPerSpin, '1–2%', r.retriggerPerSpin >= 0.01 && r.retriggerPerSpin <= 0.02],
  ['кап на 10⁷', r.caps, '5–20', r.caps >= 5 && r.caps <= 20],
  ['самая дорогая клетка', maxCellX100(params.table) / 100, '≤ 1000×', maxCellX100(params.table) <= MAX_CELL_X100],
];
const failed = checks.filter(([, , , ok]) => !ok);
function shown(name: string, value: number): string {
  if (name === 'кап на 10⁷') return String(value);
  if (name === 'самая дорогая клетка') return `${String(value)}×`;
  if (name.startsWith('фича')) return `1/${Math.round(1 / value).toString()}`;
  return pct(value);
}
const verdictLines = checks.map(([name, value, band, ok]) => `| ${name} | ${shown(name, value)} | ${band} | ${ok ? '✓' : '✗'} |`);

const previous = (() => {
  try {
    const text = readFileSync(JOURNAL, 'utf8');
    const at = text.indexOf(HISTORY);
    return at < 0 ? '' : text.slice(at).trimEnd();
  } catch {
    return '';
  }
})();

const lines = [
  '# Подбор математики — журнал',
  '',
  '> Сгенерировано `node tools/math/tune.ts`. Итоговые числа — в `docs/math.md` (сиды [0, 10⁸)).',
  '',
  `## Вариант 3 — дешевеет полоса 5–6`,
  '',
  `Цели: выигрыш ${pct(TARGET.win, 0)}, фича 1/${String(1 / TARGET.feature)}, выше ставки ${pct(TARGET.overBet, 0)} (ограничение 8.5–11.5%), клетка ≤ 1000×, кап 50–200 на 10⁸, RTP основы ${pct(TARGET.baseRtp, 2)}, RTP фичи ${pct(TARGET.featureRtp, 2)} (доля 38%), ретриггер ${pct(TARGET.retrigger, 1)} на фриспин, природный RTP с капом ${pct(TARGET.rtp, 0)}. После книги частоты — природные × 0.96 / RTP природный.`,
  '',
  'Сиды подбора [2³¹, 2³¹ + N) — общие для всех кандидатов. Веса — геометрические по ярусам (Кварц → Бриллиант) с отношением r, сумма 10 000, s — вес ядра. Таблица — черновик §4.4 × k, полоса 5–6 — ещё × m: дешевеет только нижняя полоса, верхние сохраняют пропорции черновика. Форма «m для 5–6, √m для 7–8» проверена и отвергнута: при k ≤ 10 (клетка ≤ 1000×) полоса 7–8 должна нести RTP основы, и либо «выше ставки» ≥ 14%, либо доля фичи ≥ 47%.',
  '',
  header,
  ...log,
  '',
  `Стадия 2: сетка m от 0.100 до 0.200 с шагом 0.002, для каждой новой красивой таблицы — доля «выше ставки» симуляцией. Годных (9–11%, без клетки полосы 5–6 ровно в 1.00×): ${String(eligible.length)} из ${String(lowCandidates.length)}. Взяты m = ${low.toFixed(4)}, k = ${k2.toFixed(4)} — RTP основы по линейности таблицы ближе всего к цели; предел клетки даёт k ≤ ${kCeiling.toFixed(1)}.`,
  '',
  `Стадия 4: прогноз по использованию стадии 3 с потерей на капе оттуда же — RTP ${pct(predicted.rtp, 3)}, основа ${pct(predicted.base)}; остаток до природного RTP с капом 96% добран r_f.`,
  '',
  '### Ограничения',
  '',
  '| Показатель | Итог на сидах подбора | Полоса | |',
  '|---|---|---|---|',
  ...verdictLines,
  '',
  `RTP на сидах подбора ${pct(r.rtp, 3)} ± ${pct(r.rtpError, 3)}, основа ${pct(r.baseRtp)}, фича ${pct(r.featureRtp)}.`,
  failed.length === 0 ? '' : `**Стоп: вне полосы — ${failed.map(([name]) => name).join(', ')}.**`,
  '',
  '### Итог',
  '',
  '```ts',
  `weights: { base: [${config.weights.base.join(', ')}], free: [${config.weights.free.join(', ')}] },`,
  `paytableX100: [${config.paytableX100.map((values) => `[${values.join(', ')}]`).join(', ')}],`,
  '```',
  '',
  previous,
  '',
];
writeFileSync(JOURNAL, lines.join('\n'));
console.log(verdictLines.join('\n'));
console.log(lines.slice(lines.indexOf('### Итог'), lines.indexOf('### Итог') + 6).join('\n'));
if (failed.length > 0) {
  console.log(`СТОП: вне полосы — ${failed.map(([name]) => name).join(', ')}`);
  process.exitCode = 3;
}
