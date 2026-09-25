// Подбор весов и масштаба таблицы под цели §4.5: node tools/math/tune.ts [--threads=N]
// Пишет журнал в docs/math-tuning.md и печатает итоговый конфиг. Сиды подбора — от 2³¹, общие для всех кандидатов:
// сравнение соседних кандидатов почти не шумит. Итоговый отчёт — на других сидах, [0, 10⁸) (npm run math).
//
// Стадии:
//   1. r_b и s_b — частота выигрыша 30% и фича 1/200 (2·10⁶ раундов на оценку).
//   2. k — RTP основной игры 59.5% = 96% × 62%: по линейности таблицы, без новой симуляции.
//   s_f — ретриггер 1.5% на фриспин, до стадии 3 (2·10⁶ раундов).
//   3. r_f — RTP фичи 36.5% = 96% × 38%, природный, с капом (10⁷ раундов на оценку).
//   4. Красивое округление таблицы. Шаг 0.05× у самой частой выплаты (Кварц 5–6) — 7% её значения: RTP по k идёт
//      ступеньками по 2 п.п., и k сам в 96% не попадает. Поэтому k выбирает красивую таблицу с RTP основы ближе всего
//      к 59.5% (прогноз по использованию стадии 3, потеря на капе оттуда же), а остаток добирает r_f:
//      бисекция в узком окне прямо под природный RTP с капом 96% (10⁷). Доля фичи — 1 − основа / 96%.
//   5. Итог — лучшая оценка стадии 4 на сидах подбора.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import { option } from './args.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';
import { computeReport, type MathReport } from './report.ts';
import { simulate } from './runner.ts';
import { DRAFT_PAYTABLE_X100, geometricWeights, isMonotone, niceTable, scaledTable } from './shape.ts';
import type { MathPlain } from './stats.ts';

const FROM = 2 ** 31;
const SHORT = 2_000_000;
const LONG = 10_000_000;
const threads = option('threads', os.availableParallelism());

const TARGET = { win: 0.3, feature: 1 / 200, baseRtp: 0.96 * 0.62, featureRtp: 0.96 * 0.38, retrigger: 0.015, rtp: 0.96 };

interface Params {
  readonly rb: number;
  readonly sb: number;
  readonly rf: number;
  readonly sf: number;
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
  return `| ${stage} | ${params.rb.toFixed(4)} | ${String(params.sb)} | ${params.rf.toFixed(4)} | ${String(params.sf)} | ${(rounds / 1e6).toFixed(0)}M | ${pct(r.winRate)} | 1/${Math.round(1 / r.featureRate).toString()} | ${pct(r.retriggerPerSpin)} | ${pct(r.baseRtp)} ± ${pct(r.baseRtpError)} | ${pct(r.featureRtp)} ± ${pct(r.featureRtpError)} | ${pct(r.rtp)} ± ${pct(r.rtpError)} | ${String(r.caps)} |`;
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

/** Природный RTP таблицы по использованию стадии 3: без капа — линейно, потеря на капе — из раундов, упёршихся в кап. */
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
  '| Стадия | r_b | s_b | r_f | s_f | Раундов | Выигрыш | Фича | Ретриггер | RTP основы | RTP фичи | RTP | Капов |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
console.log(header);

// Стадия 1: форма основной игры. Фриспины пока — равные веса: на частоту выигрыша и фичи они не влияют.
let params: Params = { rb: 0.92, sb: 70, rf: 1, sf: 70, table: DRAFT_PAYTABLE_X100 };
let stage1: Evaluation | null = null;
for (let round = 1; round <= 2; round++) {
  const byWin = await bisect(0.8, 1, TARGET.win, 7, false, false, (rb) => evaluate(`1.${String(round)} r_b`, { ...params, rb }, SHORT), (e) => e.report.winRate);
  params = { ...params, rb: byWin.params.rb };
  stage1 = await bisect(30, 110, TARGET.feature, 8, true, true, (sb) => evaluate(`1.${String(round)} s_b`, { ...params, sb }, SHORT), (e) => e.report.featureRate);
  params = { ...params, sb: stage1.params.sb };
}
if (stage1 === null) throw new Error('стадия 1 без итога');

// Стадия 2: масштаб таблицы по RTP основной игры при k = 1 — выплата линейна по таблице.
const k2 = TARGET.baseRtp / stage1.report.baseRtp;
console.log(`стадия 2: RTP основы при k = 1 — ${pct(stage1.report.baseRtp)}, k = ${k2.toFixed(4)}`);

// s_f — до стадии 3: ретриггер 1.5% на фриспин при пробном r_f.
params = { ...params, rf: 0.78, table: scaledTable(k2) };
const bySf = await bisect(10, 300, TARGET.retrigger, 9, true, true, (sf) => evaluate('s_f', { ...params, sf }, SHORT), (e) => e.report.retriggerPerSpin);
params = { ...params, sf: bySf.params.sf };

// Стадия 3: r_f — RTP фичи, природный, с капом. Чем меньше r_f, тем богаче фича.
let stage3 = await bisect(0.65, 0.85, TARGET.featureRtp, 8, false, false, (rf) => evaluate('3 r_f', { ...params, rf }, LONG), (e) => e.report.featureRtp);
params = { ...params, rf: stage3.params.rf };
if (stage3.report.retriggerPerSpin < 0.01 || stage3.report.retriggerPerSpin > 0.02) {
  console.log(`ретриггер ${pct(stage3.report.retriggerPerSpin)} вне 1–2% — s_f заново при r_f ${params.rf.toFixed(4)}`);
  const again = await bisect(10, 300, TARGET.retrigger, 9, true, true, (sf) => evaluate('s_f′', { ...params, sf }, SHORT), (e) => e.report.retriggerPerSpin);
  params = { ...params, sf: again.params.sf };
  stage3 = await bisect(0.65, 0.85, TARGET.featureRtp, 8, false, false, (rf) => evaluate('3′ r_f', { ...params, rf }, LONG), (e) => e.report.featureRtp);
  params = { ...params, rf: stage3.params.rf };
}

// Стадия 4: красивая таблица с RTP основы ближе всего к цели, затем r_f — под природный RTP с капом 96%.
const scan: { k: number; table: number[][]; rtp: number; base: number; feature: number }[] = [];
for (let step = -100; step <= 100; step++) {
  const k = k2 * (1 + step / 1000);
  const table = niceTable(k);
  if (!isMonotone(table)) continue;
  scan.push({ k, table, ...predict(stage3.plain, table) });
}
const chosen = scan.reduce((a, b) => (Math.abs(b.base - TARGET.baseRtp) < Math.abs(a.base - TARGET.baseRtp) ? b : a));
const nearest = scan.reduce((a, b) => (Math.abs(b.rtp - TARGET.rtp) < Math.abs(a.rtp - TARGET.rtp) ? b : a));
console.log(
  `стадия 4: k = ${chosen.k.toFixed(4)}, прогноз RTP основы ${pct(chosen.base)}, всего ${pct(chosen.rtp, 3)}; ` +
    `ближайший к 96% на всей лестнице k — ${pct(nearest.rtp, 3)}`,
);
params = { ...params, table: chosen.table };
const final = await bisect(
  params.rf - 0.006,
  params.rf + 0.006,
  TARGET.rtp,
  6,
  false,
  false,
  (rf) => evaluate('4 r_f', { ...params, rf }, LONG),
  (e) => e.report.rtp,
);
params = final.params;
const config = configOf(params);

const lines = [
  '# Подбор математики — журнал',
  '',
  '> Сгенерировано `node tools/math/tune.ts`. Итоговые числа — в `docs/math.md` (сиды [0, 10⁸)).',
  '',
  `Цели: выигрыш ${pct(TARGET.win, 0)}, фича 1/${String(1 / TARGET.feature)}, RTP основы ${pct(TARGET.baseRtp, 2)}, RTP фичи ${pct(TARGET.featureRtp, 2)} (доля 38%), ретриггер ${pct(TARGET.retrigger, 1)} на фриспин, природный RTP с капом ${pct(TARGET.rtp, 0)}. После книги частоты — природные × 0.96 / RTP природный; при RTP ≈ 96% книга почти не меняет игру.`,
  '',
  `Сиды подбора [2³¹, 2³¹ + N) — общие для всех кандидатов; веса — геометрические по ярусам (Кварц → Бриллиант) с отношением r, сумма 10 000, s — вес ядра. Таблица — черновик §4.4 × k.`,
  '',
  header,
  ...log,
  '',
  `Стадия 2: RTP основы при k = 1 — ${pct(stage1.report.baseRtp, 3)}, k = ${k2.toFixed(4)}.`,
  '',
  `Стадия 4: красивое округление (ниже 1× — шаг 0.05, до 10× — 0.1, дальше — 1×). Шаг 0.05× у самой частой выплаты — Кварц 5–6 — это 7% её значения: прогноз RTP по k идёт ступеньками около 2 п.п., ближайшая к 96% ступень — ${pct(nearest.rtp, 3)}. Поэтому k = ${chosen.k.toFixed(4)} выбран по RTP основы (прогноз ${pct(chosen.base, 2)} при цели ${pct(TARGET.baseRtp, 2)}; потеря на капе — из использования стадии 3), а остаток добран r_f: бисекция под природный RTP с капом 96% на 10⁷. Отступление от плана (там остаток добирал k) — из-за этого шага.`,
  '',
  `Итог на сидах подбора: RTP ${pct(final.report.rtp, 3)} ± ${pct(final.report.rtpError, 3)}, основа ${pct(final.report.baseRtp)}, фича ${pct(final.report.featureRtp)} — доля ${pct(final.report.featureShare, 1)}.`,
  '',
  '## Итог',
  '',
  '```ts',
  `weights: { base: [${config.weights.base.join(', ')}], free: [${config.weights.free.join(', ')}] },`,
  `paytableX100: [${config.paytableX100.map((row) => `[${row.join(', ')}]`).join(', ')}],`,
  '```',
  '',
];
writeFileSync('docs/math-tuning.md', lines.join('\n'));
console.log(lines.slice(-6).join('\n'));
