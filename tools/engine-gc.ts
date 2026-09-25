// Замер аллокаций горячего пути движка: сборки молодого поколения на 10^5 раундов тихого режима.
// Положительный контроль — тот же прогон с записью событий: он аллоцирует по формату и обязан давать сборки.
// Сначала прогрев — JIT компилирует горячие функции и сам аллоцирует. Прогонов 5, в отчёт — худший.
// Запуск: node tools/engine-gc.ts
import { GCProfiler, getHeapSpaceStatistics } from 'node:v8';
import { EventRecorder, SeededEngine, SilentRecorder, type RoundRecorder } from '../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../src/core/model/config.ts';

const ROUNDS = 100_000;
const WARMUP = 20_000;
const RUNS = 5;
const YOUNG = new Set(['Scavenge', 'MinorMarkSweep']);

interface Sample {
  readonly young: number;
  readonly other: number;
  readonly freedMb: number;
}

function measure(recorder: RoundRecorder, run: number): Sample {
  const engine = new SeededEngine(DEFAULT_CONFIG, recorder);
  for (let seed = 0; seed < WARMUP; seed++) engine.play(seed);
  const from = WARMUP + run * ROUNDS;
  const profiler = new GCProfiler();
  profiler.start();
  for (let seed = from; seed < from + ROUNDS; seed++) engine.play(seed);
  const { statistics } = profiler.stop();
  let young = 0;
  let freed = 0;
  for (const gc of statistics) {
    if (!YOUNG.has(gc.gcType)) continue;
    young += 1;
    freed += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
  }
  return { young, other: statistics.length - young, freedMb: freed / 2 ** 20 };
}

function worst(name: string, make: () => RoundRecorder): Sample {
  const samples = Array.from({ length: RUNS }, (_, run) => measure(make(), run));
  const result = samples.reduce((a, b) => (b.young > a.young ? b : a));
  const all = samples.map((sample) => sample.young).join(', ');
  console.log(
    `${name}: худший из ${String(RUNS)} — ${String(result.young)} сборок молодого поколения ` +
      `(по прогонам: ${all}), прочих ${String(result.other)}, освобождено ${result.freedMb.toFixed(1)} МБ`,
  );
  return result;
}

console.log(`Node ${process.version}, V8 ${process.versions.v8}; ${String(ROUNDS)} раундов DEFAULT_CONFIG после прогрева ${String(WARMUP)}`);
const control = worst('запись (положительный контроль)', () => new EventRecorder());
const silent = worst('тихий режим', () => new SilentRecorder());
// Ноль сборок значит: за прогон выделено меньше, чем вмещает молодое поколение, — отсюда граница на раунд.
const newSpace = getHeapSpaceStatistics().find((space) => space.space_name === 'new_space')?.space_size ?? 0;
console.log(
  `молодое поколение ${(newSpace / 2 ** 20).toFixed(1)} МБ: ноль сборок — меньше ${String(Math.ceil(newSpace / ROUNDS))} байт на раунд`,
);
if (control.young === 0) {
  console.log('Контроль не поймал ни одной сборки — замеру верить нельзя.');
  process.exitCode = 1;
} else if (silent.young > 0) {
  console.log('В тихом режиме есть сборки молодого поколения — горячий путь аллоцирует.');
  process.exitCode = 1;
}
