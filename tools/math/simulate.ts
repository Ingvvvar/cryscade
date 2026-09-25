// Симуляция и отчёт: node tools/math/simulate.ts [--rounds=N] [--from=N] [--threads=N] [--task=N] [--max-requests=N] [--out=путь]
// По умолчанию — прообраз книги (§5): сиды [0, 10⁸), отчёт в docs/math.md.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { computeReport, renderMarkdown } from './report.ts';
import { simulate } from './runner.ts';
import { measureThroughput } from './throughput.ts';

/**
 * Порог сторожа симулятора — запросов за раунд; задаёт вызывающий (§4.7). Самый длинный честный раунд черновика
 * на 10⁵ сидах — 1072, стресс-конфига — 2017. Порог в сотни раз выше: кандидаты подбора с длинной фичей проходят,
 * надкритичный — падает с сидом, а не висит.
 */
const MAX_REQUESTS = 1_000_000;

function option(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return fallback;
  const value = Number(raw.replaceAll('_', ''));
  if (!Number.isSafeInteger(value)) throw new RangeError(`--${name}: ${raw}`);
  return value;
}

const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? 'docs/math.md';
const plan = {
  config: DEFAULT_CONFIG,
  from: option('from', 0),
  rounds: option('rounds', 100_000_000),
  taskSize: option('task', 100_000),
  maxRequests: option('max-requests', MAX_REQUESTS),
};
const threads = option('threads', os.availableParallelism());

const cpu = os.cpus()[0]?.model ?? 'неизвестный CPU';
const environment = `${cpu}, ядер ${String(os.availableParallelism())}; Node ${process.version}, V8 ${process.versions.v8}.`;
console.log(environment);

const speed = measureThroughput(plan.config, plan.maxRequests);
console.log(`одно ядро: тихий режим ${Math.round(speed.silentPerCore).toLocaleString('ru-RU')} раундов/с, симулятор ${Math.round(speed.statsPerCore).toLocaleString('ru-RU')}`);

const started = performance.now();
const plain = await simulate(plan, threads);
const seconds = (performance.now() - started) / 1000;
console.log(`${plan.rounds.toLocaleString('ru-RU')} раундов за ${seconds.toFixed(1)} с на ${String(threads)} потоках`);

const report = computeReport(plain, plan.config);
const throughput =
  `Одно ядро, худший из 5 замеров по 2·10⁵ раундов после прогрева: тихий режим ${Math.round(speed.silentPerCore).toLocaleString('ru-RU')} раундов/с, ` +
  `путь симулятора (StatsRecorder и сборщик) ${Math.round(speed.statsPerCore).toLocaleString('ru-RU')} раундов/с. ` +
  `Весь прогон: ${Math.round(plan.rounds / seconds).toLocaleString('ru-RU')} раундов/с на ${String(threads)} потоках.`;
writeFileSync(
  out,
  renderMarkdown(report, plan.config, { from: plan.from, threads, taskSize: plan.taskSize, maxRequests: plan.maxRequests, seconds, environment, throughput }),
);
console.log(`RTP ${(report.rtp * 100).toFixed(3)}% ± ${(report.ci99 * 100).toFixed(3)}; отчёт — ${out}`);
