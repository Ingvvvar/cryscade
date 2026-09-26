// Пропускная способность одного ядра: node tools/math/speed.ts [--wait=300] [--control]
// Пишет раздел «Пропускная способность» в docs/math.md между маркерами. Сначала ждёт до 5 минут, пока средняя
// нагрузка за минуту опустится до порога: хвост своего же прогона спадает несколько минут. Не опустилась — или
// поднялась за время замера — число не пишется: «стенд занят» с цифрами нагрузки.
// Порог — 0.4 × число логических ядер (os.availableParallelism()): свой поток замера добавляет к нагрузке до 1,
// остальное — запас на фон системы; абсолютный порог не учитывал размер машины.
// --control — положительный контроль: нагружает все ядра, ждёт, пока нагрузка перейдёт порог, и держит нагрузку
// всё ожидание замера; замер обязан отказаться. Числа в отчёт не пишет, код выхода 0 — только если отказался.
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { flag, option } from './args.ts';
import { SPEED_CLOSE, SPEED_OPEN } from './report.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';
import { loadThreshold, verdict, waitForIdle, type Clock, type Verdict } from './speed-verdict.ts';
import { measureThroughput } from './throughput.ts';

const REPORT = 'docs/math.md';
const cores = os.availableParallelism();
const threshold = loadThreshold(cores);
const WAIT_MS = option('wait', 300) * 1000;
const clock: Clock = { now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const minuteLoad = (): number => os.loadavg()[0] ?? Number.NaN;
const environment = `${os.cpus()[0]?.model ?? 'неизвестный CPU'}, ядер ${String(os.availableParallelism())}; Node ${process.version}, V8 ${process.versions.v8}.`;

async function measure(): Promise<Verdict> {
  const wait = await waitForIdle(minuteLoad, threshold, WAIT_MS, clock);
  if (!wait.idle) return verdict({ cores, before: wait.load, after: Number.NaN, threshold, waitedMs: wait.waitedMs }, null, environment);
  const speed = measureThroughput(DEFAULT_CONFIG, SIMULATOR_MAX_REQUESTS);
  return verdict({ cores, before: wait.load, after: minuteLoad(), threshold, waitedMs: wait.waitedMs }, speed, environment);
}

async function control(): Promise<void> {
  const burners = Array.from({ length: os.availableParallelism() }, () => new Worker('for (;;) {}', { eval: true }));
  try {
    const deadline = performance.now() + 180_000;
    while (minuteLoad() <= threshold) {
      if (performance.now() > deadline) throw new Error(`контроль: нагрузка не поднялась выше ${String(threshold)} за 3 минуты`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const result = await measure();
    console.log(result.text);
    if (result.measured) {
      console.log('КОНТРОЛЬ ПРОВАЛЕН: под искусственной нагрузкой замер записал число.');
      process.exitCode = 1;
    } else {
      console.log('Контроль пройден: под искусственной нагрузкой замер отказался.');
    }
  } finally {
    await Promise.all(burners.map((burner) => burner.terminate()));
  }
}

if (flag('control')) {
  await control();
} else {
  const result = await measure();
  console.log(result.text);
  const report = readFileSync(REPORT, 'utf8');
  const open = report.indexOf(SPEED_OPEN);
  const close = report.indexOf(SPEED_CLOSE);
  if (open < 0 || close < open) throw new Error(`${REPORT}: нет раздела скорости между маркерами — сначала npm run math`);
  writeFileSync(REPORT, `${report.slice(0, open + SPEED_OPEN.length)}\n${result.text}\n${report.slice(close)}`);
  if (!result.measured) process.exitCode = 2;
}
