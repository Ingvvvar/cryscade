// Подбор весов, масштаба и крутизны таблицы под цели §4.5: node tools/math/tune.ts [--threads=N]
// Пишет журнал в docs/math-tuning.md (раздел «Прежние варианты» сохраняется) и печатает итоговый конфиг.
// Сиды подбора — от 2³¹, общие для всех кандидатов: сравнение соседних кандидатов почти не шумит.
// Итоговый отчёт — на других сидах, [0, 10⁸) (npm run math). Код выхода 3 — ограничение не выполнено: стоп.
//
// Стадии:
//   1. r_b и s_b — частота выигрыша 30% и фича 1/200 (2·10⁶ раундов на оценку); от таблицы не зависят.
//   2. Крутизна s — доля выигрышей больше ставки 10% (полоса 8–12%). Таблица — черновик × k(s) × (полоса + 1)^s,
//      где k(s) держит RTP основы 59.5% = 96% × 62% по линейности таблицы (использование стадии 1).
//   s_f — ретриггер 1.5% на фриспин, до стадии 3.
//   3. r_f — RTP фичи 36.5% = 96% × 38%, природный, с капом (10⁷ раундов на оценку).
//   4. Красивое округление: кандидаты k при той же крутизне — по близости RTP основы к цели (прогноз по использованию
//      стадии 3, потеря на капе оттуда же); доля «выше ставки» каждого проверяется симуляцией, первый в 8.5–11.5%
//      берётся. Остаток до природного RTP с капом 96% добирает r_f: бисекция в узком окне (10⁷).
//   5. Ограничения: выигрыш 25–35%, фича 1/250–1/150, «выше ставки» 8–12% — после книги; доля фичи 35–41%,
//      ретриггер 1–2%, кап не реже 5 на 10⁷ (итог по капу — отчёт на 10⁸).
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import { option } from './args.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';
import { computeReport, TARGET_RTP, type MathReport } from './report.ts';
import { simulate } from './runner.ts';
import { DRAFT_PAYTABLE_X100, geometricWeights, isMonotone, niceTable, scaledTable } from './shape.ts';
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
  /** Крутизна таблицы по полосам. */
  readonly steep: number;
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
    params.steep.toFixed(4),
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
  '| Стадия | r_b | s_b | r_f | s_f | крутизна | Раундов | Выигрыш | Выше ставки | Фича | Ретриггер | RTP основы | RTP фичи | RTP | Капов |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
console.log(header);

// Стадия 1: форма основной игры на черновике. Фриспины — равные веса: на частоту выигрыша и фичи они не влияют.
let params: Params = { rb: 0.92, sb: 70, rf: 1, sf: 70, steep: 0, table: DRAFT_PAYTABLE_X100 };
let stage1: Evaluation | null = null;
for (let round = 1; round <= 2; round++) {
  const byWin = await bisect(0.8, 1, TARGET.win, 7, false, false, (rb) => evaluate(`1.${String(round)} r_b`, { ...params, rb }, SHORT), (e) => e.report.winRate);
  params = { ...params, rb: byWin.params.rb };
  stage1 = await bisect(30, 110, TARGET.feature, 8, true, true, (sb) => evaluate(`1.${String(round)} s_b`, { ...params, sb }, SHORT), (e) => e.report.featureRate);
  params = { ...params, sb: stage1.params.sb };
}
if (stage1 === null) throw new Error('стадия 1 без итога');
const baseUsage = stage1.plain;

// Стадия 2: крутизна по доле «выше ставки»; k(s) — по линейности RTP основы на черновике (кап в основе при k = 1 не бывает).
function scaleFor(steep: number): number {
  const shaped = scaledTable(1, steep);
  return TARGET.baseRtp / predict(baseUsage, shaped).base;
}
params = { ...params, rf: 0.8, sf: 95 };
const bySteep = await bisect(
  0,
  3,
  TARGET.overBet,
  9,
  false,
  false,
  (steep) => evaluate('2 крутизна', { ...params, steep, table: scaledTable(scaleFor(steep), steep) }, SHORT),
  (e) => e.report.overBetRate,
);
const steep = bySteep.params.steep;
const k2 = scaleFor(steep);
params = { ...params, steep, table: scaledTable(k2, steep) };
console.log(`стадия 2: крутизна ${steep.toFixed(4)}, k = ${k2.toFixed(4)}`);

// s_f — до стадии 3: ретриггер 1.5% на фриспин при пробном r_f.
const bySf = await bisect(10, 300, TARGET.retrigger, 9, true, true, (sf) => evaluate('s_f', { ...params, sf }, SHORT), (e) => e.report.retriggerPerSpin);
params = { ...params, sf: bySf.params.sf };

// Стадия 3: r_f — RTP фичи, природный, с капом. Чем меньше r_f, тем богаче фича; крутая таблица сдвигает её вверх.
let stage3 = await bisect(0.65, 0.95, TARGET.featureRtp, 9, false, false, (rf) => evaluate('3 r_f', { ...params, rf }, LONG), (e) => e.report.featureRtp);
params = { ...params, rf: stage3.params.rf };
if (stage3.report.retriggerPerSpin < 0.01 || stage3.report.retriggerPerSpin > 0.02) {
  console.log(`ретриггер ${pct(stage3.report.retriggerPerSpin)} вне 1–2% — s_f заново при r_f ${params.rf.toFixed(4)}`);
  const again = await bisect(10, 300, TARGET.retrigger, 9, true, true, (sf) => evaluate('s_f′', { ...params, sf }, SHORT), (e) => e.report.retriggerPerSpin);
  params = { ...params, sf: again.params.sf };
  stage3 = await bisect(0.65, 0.95, TARGET.featureRtp, 9, false, false, (rf) => evaluate('3′ r_f', { ...params, rf }, LONG), (e) => e.report.featureRtp);
  params = { ...params, rf: stage3.params.rf };
}

// Стадия 4: красивое округление при той же крутизне; кандидаты — по близости RTP основы к цели, «выше ставки» — симуляцией.
const seen = new Set<string>();
const candidates: { k: number; table: number[][]; base: number; rtp: number }[] = [];
for (let step = -150; step <= 150; step++) {
  const k = k2 * (1 + step / 1000);
  const table = niceTable(k, steep);
  const key = JSON.stringify(table);
  if (!isMonotone(table) || seen.has(key)) continue;
  seen.add(key);
  candidates.push({ k, table, ...predict(stage3.plain, table) });
}
candidates.sort((a, b) => Math.abs(a.base - TARGET.baseRtp) - Math.abs(b.base - TARGET.baseRtp));
let chosen: (typeof candidates)[number] | null = null;
const tried: string[] = [];
for (const candidate of candidates.slice(0, 8)) {
  const check = await evaluate('4 округление', { ...params, table: candidate.table }, SHORT);
  tried.push(`k = ${candidate.k.toFixed(4)}: основа ${pct(candidate.base)} (прогноз), выше ставки ${pct(check.report.overBetRate)}`);
  if (check.report.overBetRate >= 0.085 && check.report.overBetRate <= 0.115) {
    chosen = candidate;
    break;
  }
}
if (chosen === null) {
  chosen = candidates[0] ?? null;
  console.log('стадия 4: ни один из 8 ближайших кандидатов не дал «выше ставки» в 8.5–11.5% — берётся ближайший по RTP основы');
}
if (chosen === null) throw new Error('стадия 4 без кандидатов');
console.log(`стадия 4: k = ${chosen.k.toFixed(4)}, прогноз RTP основы ${pct(chosen.base)}`);
params = { ...params, table: chosen.table };
const final = await bisect(params.rf - 0.01, params.rf + 0.01, TARGET.rtp, 7, false, false, (rf) => evaluate('4 r_f', { ...params, rf }, LONG), (e) => e.report.rtp);
params = final.params;
const config = configOf(params);

// Стадия 5: ограничения. Частоты после книги — природные × 0.96 / RTP природный.
const r = final.report;
const c = TARGET_RTP / r.rtp;
const checks: [string, number, string, boolean][] = [
  ['выигрыш после книги', r.winRate * c, '25–35%', r.winRate * c >= 0.25 && r.winRate * c <= 0.35],
  ['фича после книги', r.featureRate * c, '1/250–1/150', r.featureRate * c >= 1 / 250 && r.featureRate * c <= 1 / 150],
  ['выше ставки после книги', r.overBetRate * c, '8–12%', r.overBetRate * c >= 0.08 && r.overBetRate * c <= 0.12],
  ['доля фичи', r.featureShare, '35–41%', r.featureShare >= 0.35 && r.featureShare <= 0.41],
  ['ретриггер на фриспин', r.retriggerPerSpin, '1–2%', r.retriggerPerSpin >= 0.01 && r.retriggerPerSpin <= 0.02],
  ['кап на 10⁷', r.caps, '≥ 5', r.caps >= 5],
];
const failed = checks.filter(([, , , ok]) => !ok);
const verdictLines = checks.map(([name, value, band, ok]) => `| ${name} | ${name === 'кап на 10⁷' ? String(value) : name.startsWith('фича') ? `1/${Math.round(1 / value).toString()}` : pct(value)} | ${band} | ${ok ? '✓' : '✗'} |`);

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
  `## Вариант 2 — крутая таблица`,
  '',
  `Цели: выигрыш ${pct(TARGET.win, 0)}, фича 1/${String(1 / TARGET.feature)}, выше ставки ${pct(TARGET.overBet, 0)} (ограничение 8–12%), RTP основы ${pct(TARGET.baseRtp, 2)}, RTP фичи ${pct(TARGET.featureRtp, 2)} (доля 38%), ретриггер ${pct(TARGET.retrigger, 1)} на фриспин, природный RTP с капом ${pct(TARGET.rtp, 0)}. После книги частоты — природные × 0.96 / RTP природный.`,
  '',
  'Сиды подбора [2³¹, 2³¹ + N) — общие для всех кандидатов. Веса — геометрические по ярусам (Кварц → Бриллиант) с отношением r, сумма 10 000, s — вес ядра. Таблица — черновик §4.4 × k × (полоса + 1)^крутизна, полоса 5–6 — номер 0.',
  '',
  header,
  ...log,
  '',
  `Стадия 2: крутизна ${steep.toFixed(4)}, k = ${k2.toFixed(4)} — RTP основы по линейности таблицы на использовании стадии 1.`,
  '',
  `Стадия 4: красивое округление (ниже 1× — шаг 0.05, до 10× — 0.1, дальше — 1×) при той же крутизне. Кандидаты по близости прогноза RTP основы к ${pct(TARGET.baseRtp, 2)}: ${tried.join('; ')}. Взят k = ${chosen.k.toFixed(4)}; остаток до природного RTP с капом 96% добран r_f.`,
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
