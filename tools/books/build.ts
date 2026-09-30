// Книга исходов (§5): node tools/books/build.ts [--threads=N] [--check]
// Прообраз — сиды [0, 10⁸) конфига игры; корзины §5, в корзине — нижние BOOK_PER_BUCKET по хешу сида, редкие — все;
// веса и пул проигрышей — select.ts. Пишет public/books/base.v1.<SHA-256 несжатых байт, 12 знаков>.bin.gz, манифест
// public/books/base.v1.json (для людей: воркер его не читает — эталонный хеш вшивает сборка, vite.config.ts) и отчёт
// по книге docs/math.md. --check — ничего не пишет: пересобирает и сверяет несжатые байты с книгой в public/books.
// Хеш — от несжатых байт: gzip другой версии zlib вправе сжать иначе, а книга от этого не меняется.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { decodeBook, encodeBook } from '../../src/server/book.ts';
import { flag, option } from '../math/args.ts';
import { SIMULATOR_MAX_REQUESTS } from '../math/limits.ts';
import { computeReport } from '../math/report.ts';
import { BOOK_PER_BUCKET } from './collector.ts';
import { BOOK_DIR, BOOK_FILE, BOOK_MANIFEST, bookFileName, findBook } from './files.ts';
import { bookFacts, decimal, renderBookMarkdown } from './report.ts';
import { prototype } from './runner.ts';
import { selectBook } from './select.ts';

const FROM = 0;
const ROUNDS = 100_000_000;
const MAX_GZIP_BYTES = 1_048_576;

const threads = option('threads', os.availableParallelism());
const check = flag('check');
const plan = { config: DEFAULT_CONFIG, from: FROM, rounds: ROUNDS, taskSize: 100_000, maxRequests: SIMULATOR_MAX_REQUESTS };

const started = performance.now();
const proto = await prototype(plan, threads);
console.log(`прообраз: ${ROUNDS.toLocaleString('ru-RU')} раундов за ${((performance.now() - started) / 1000).toFixed(0)} с`);
const selected = selectBook(proto.collector);
const raw = encodeBook(selected.records);
const sha256 = createHash('sha256').update(raw).digest('hex');
const file = bookFileName(sha256);
console.log(`книга: ${String(selected.records.length)} записей, SHA-256 ${sha256}, RTP ${decimal(selected.paid, 100n * selected.total, 12)}`);

if (check) {
  const name = findBook();
  const stored = gunzipSync(readFileSync(`${BOOK_DIR}/${name}`));
  const same = Buffer.compare(stored, Buffer.from(raw)) === 0;
  console.log(same ? `пересборка побайтно равна ${name}` : `пересборка отличается от ${name}`);
  if (!same) process.exitCode = 1;
} else {
  const gz = gzipSync(raw, { level: 9 });
  if (gz.length > MAX_GZIP_BYTES) throw new Error(`книга ${String(gz.length)} Б gzip — больше 1 МБ`);
  const read = decodeBook(raw, DEFAULT_CONFIG.capX100);
  if (!read.ok) throw new Error(read.problem);
  const facts = bookFacts(read.book, DEFAULT_CONFIG);
  mkdirSync(BOOK_DIR, { recursive: true });
  for (const name of readdirSync(BOOK_DIR)) if (BOOK_FILE.test(name)) rmSync(`${BOOK_DIR}/${name}`);
  writeFileSync(`${BOOK_DIR}/${file}`, gz);
  const manifest = {
    file,
    sha256,
    records: selected.records.length,
    weightTotal: selected.total.toString(),
    rtp: { numerator: selected.paid.toString(), denominator: (100n * selected.total).toString(), decimal: decimal(selected.paid, 100n * selected.total, 15) },
    prototype: { seeds: [FROM, FROM + ROUNDS], perBucket: BOOK_PER_BUCKET, bucketRounds: proto.collector.counts },
    configSha256: createHash('sha256').update(JSON.stringify(DEFAULT_CONFIG)).digest('hex'),
    maxWin: { index: facts.top.index, payX100: facts.top.payX100, seed: facts.top.seed },
  };
  writeFileSync(`${BOOK_DIR}/${BOOK_MANIFEST}`, `${JSON.stringify(manifest, null, 2)}\n`);
  const report = computeReport(proto.stats, DEFAULT_CONFIG);
  writeFileSync(
    'docs/math.md',
    renderBookMarkdown(facts, DEFAULT_CONFIG, {
      file,
      sha256,
      gzipBytes: gz.length,
      rawBytes: raw.length,
      from: FROM,
      rounds: ROUNDS,
      perBucket: BOOK_PER_BUCKET,
      prototype: report,
      prototypeCounts: proto.collector.counts,
    }),
  );
  console.log(`записано: ${BOOK_DIR}/${file} (${String(gz.length)} Б gzip), ${BOOK_DIR}/${BOOK_MANIFEST}, docs/math.md`);
}
