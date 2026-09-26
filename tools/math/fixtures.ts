// Фикстуры раундов для визуального среза и презентации: node tools/math/fixtures.ts [--threads=N]
// Конфиг игры. Сид — первый по возрастанию от 0, для которого выполнено условие; «самый крупный» — наибольший
// выигрыш на сидах отчёта [0, 10⁸), при равенстве — меньший сид (сборщик симулятора). Пересборка детерминирована:
// те же файлы байт в байт. Устаревшие фикстуры ловит тест: SHA-256 конфига и пересчёт событий по сиду.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { EventRecorder, SeededEngine } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { option } from './args.ts';
import { FIXTURES, configFingerprint, formatFixture, summarize, type Fixture } from './fixture-specs.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';
import { simulate } from './runner.ts';

const DIR = 'fixtures/rounds';
const SEARCH_LIMIT = 10_000_000;
const threads = option('threads', os.availableParallelism());
const fingerprint = configFingerprint(DEFAULT_CONFIG);

const recorder = new EventRecorder();
const engine = new SeededEngine(DEFAULT_CONFIG, recorder, { maxRequests: SIMULATOR_MAX_REQUESTS });

function record(name: string, description: string, seed: number): Fixture {
  const payX100 = engine.play(seed);
  return { name, description, seed, config: 'DEFAULT_CONFIG', configSha256: fingerprint, payX100, events: [...recorder.events] };
}

const found = new Map<string, Fixture>();
const wanted = FIXTURES.filter((spec) => spec.accepts !== null);
for (let seed = 0; seed < SEARCH_LIMIT && found.size < wanted.length; seed++) {
  engine.play(seed);
  const summary = summarize(recorder.events);
  for (const spec of wanted) {
    if (!found.has(spec.name) && spec.accepts?.(summary) === true) found.set(spec.name, record(spec.name, spec.description, seed));
  }
}
const missing = wanted.filter((spec) => !found.has(spec.name)).map((spec) => spec.name);
if (missing.length > 0) throw new Error(`не найдено на ${String(SEARCH_LIMIT)} сидах: ${missing.join(', ')}`);

const biggest = FIXTURES.find((spec) => spec.accepts === null);
if (biggest !== undefined) {
  const plain = await simulate({ config: DEFAULT_CONFIG, from: 0, rounds: 100_000_000, taskSize: 100_000, maxRequests: SIMULATOR_MAX_REQUESTS }, threads);
  found.set(biggest.name, record(biggest.name, biggest.description, plain.top.seed));
}

mkdirSync(DIR, { recursive: true });
const names = new Set(FIXTURES.map((spec) => `${spec.name}.json`));
for (const file of readdirSync(DIR)) {
  if (file.endsWith('.json') && !names.has(file)) rmSync(`${DIR}/${file}`);
}
for (const spec of FIXTURES) {
  const fixture = found.get(spec.name);
  if (fixture === undefined) throw new Error(`нет фикстуры ${spec.name}`);
  writeFileSync(`${DIR}/${spec.name}.json`, formatFixture(fixture));
  console.log(`${spec.name}: сид ${String(fixture.seed)}, ${(fixture.payX100 / 100).toFixed(2)}×, событий ${String(fixture.events.length)}`);
}
