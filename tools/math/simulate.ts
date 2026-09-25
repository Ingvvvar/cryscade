// Симуляция и отчёт: node tools/math/simulate.ts [--rounds=N] [--from=N] [--threads=N] [--task=N] [--max-requests=N] [--out=путь]
// По умолчанию — прообраз книги (§5): сиды [0, 10⁸), отчёт в docs/math.md. Время и скорость в отчёт не пишутся:
// они зависят от нагрузки стенда — их меряет `npm run math:speed`.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { computeReport, renderMarkdown } from './report.ts';
import { simulate } from './runner.ts';
import { option } from './args.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';

const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? 'docs/math.md';
const plan = {
  config: DEFAULT_CONFIG,
  from: option('from', 0),
  rounds: option('rounds', 100_000_000),
  taskSize: option('task', 100_000),
  maxRequests: option('max-requests', SIMULATOR_MAX_REQUESTS),
};
const threads = option('threads', os.availableParallelism());

const started = performance.now();
const plain = await simulate(plan, threads);
console.log(`${plan.rounds.toLocaleString('ru-RU')} раундов за ${((performance.now() - started) / 1000).toFixed(1)} с на ${String(threads)} потоках`);

const report = computeReport(plain, plan.config);
writeFileSync(out, renderMarkdown(report, plan.config, { from: plan.from, threads, taskSize: plan.taskSize, maxRequests: plan.maxRequests }));
console.log(`RTP ${(report.rtp * 100).toFixed(3)}% ± ${(report.ci99 * 100).toFixed(3)}; отчёт — ${out}`);
