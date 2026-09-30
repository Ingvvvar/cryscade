import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SeededEngine, SilentRecorder } from '../../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { BOOK_MAX_RECORDS, decodeBook, encodeBook, type Book } from '../../../src/server/book.ts';
import { BOOK_DIR, BOOK_MANIFEST, bookFileName, findBook } from '../../../tools/books/files.ts';
import { prototype, prototypeInProcess } from '../../../tools/books/runner.ts';
import { selectBook } from '../../../tools/books/select.ts';
import { SIMULATOR_MAX_REQUESTS } from '../../../tools/math/limits.ts';

// Книга в репозитории (§5, фаза 6): байты закреплены золотым SHA-256 несжатой книги — любая пересборка на другом
// движке, конфиге или отборе меняет его; обновлять осознанно, как золотую сумму. Полная пересборка из прообраза 10⁸ —
// `npm run book:check` (минута на 10 потоках); здесь — тот же конвейер на малом прообразе в 1 и 3 потоках.

const GOLDEN_SHA256 = 'bda29460a5ec0947c65bd36ae1e3ebcd22089e71b9423c2d373139ef77f48555';

function stored(): { name: string; gz: Buffer; raw: Buffer } {
  const name = findBook();
  const gz = readFileSync(`${BOOK_DIR}/${name}`);
  return { name, gz, raw: gunzipSync(gz) };
}

function book(raw: Uint8Array): Book {
  const read = decodeBook(raw, DEFAULT_CONFIG.capX100);
  if (!read.ok) throw new Error(read.problem);
  return read.book;
}

describe('книга в public/books', () => {
  const { name, gz, raw } = stored();
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = book(raw);

  it('SHA-256 несжатой книги — золотой литерал; имя файла — с его первыми 12 знаками', () => {
    expect(sha256).toBe(GOLDEN_SHA256);
    expect(name).toBe(bookFileName(GOLDEN_SHA256));
    expect(name).toBe('base.v1.bda29460a5ec.bin.gz');
  });

  it('не больше 80 000 записей и 1 МБ gzip', () => {
    expect(loaded.size).toBeLessThanOrEqual(BOOK_MAX_RECORDS);
    expect(BOOK_MAX_RECORDS).toBe(80_000);
    expect(gz.length).toBeLessThanOrEqual(1_048_576);
  });

  it('RTP книги — 0.96 с точностью 1e-9, в целых: |Σ веса × итог − 96 × W| × 10⁹ < 100 × W', () => {
    let paid = 0n;
    let total = 0n;
    for (let index = 0; index < loaded.size; index++) {
      const record = loaded.record(index);
      paid += BigInt(record.weight) * BigInt(record.payX100);
      total += BigInt(record.weight);
    }
    const deviation = paid - 96n * total;
    expect((deviation < 0n ? -deviation : deviation) * 1_000_000_000n).toBeLessThan(100n * total);
    expect(total).toBe(BigInt(loaded.total));
  });

  it('каждая запись сверена с движком: сид даёт ровно свой итог', () => {
    const engine = new SeededEngine(DEFAULT_CONFIG, new SilentRecorder(), { maxRequests: SIMULATOR_MAX_REQUESTS });
    const wrong: string[] = [];
    for (let index = 0; index < loaded.size; index++) {
      const record = loaded.record(index);
      const payX100 = engine.play(record.seed);
      if (payX100 !== record.payX100) wrong.push(`${String(index)}: сид ${String(record.seed)} — ${String(payX100)}, в книге ${String(record.payX100)}`);
    }
    expect(loaded.size).toBeGreaterThan(50_000);
    expect(wrong).toStrictEqual([]);
  }, 60_000);

  it('записи — по итогу, потом по сиду; сиды не повторяются; последняя — кап', () => {
    let previous = { payX100: -1, seed: -1 };
    const seeds = new Set<number>();
    for (let index = 0; index < loaded.size; index++) {
      const record = loaded.record(index);
      expect(record.payX100 > previous.payX100 || (record.payX100 === previous.payX100 && record.seed > previous.seed)).toBe(true);
      seeds.add(record.seed);
      previous = record;
    }
    expect(seeds.size).toBe(loaded.size);
    expect(previous.payX100).toBe(DEFAULT_CONFIG.capX100);
  });

  it('манифест рядом — для людей — называет тот же файл и хеш; прообраз — 10⁸ сидов', () => {
    const manifest = JSON.parse(readFileSync(`${BOOK_DIR}/${BOOK_MANIFEST}`, 'utf8')) as {
      file: string;
      sha256: string;
      records: number;
      prototype: { seeds: number[]; bucketRounds: number[] };
    };
    expect([manifest.file, manifest.sha256, manifest.records]).toStrictEqual([name, GOLDEN_SHA256, loaded.size]);
    expect(manifest.prototype.seeds).toStrictEqual([0, 100_000_000]);
    expect(manifest.prototype.bucketRounds.reduce((a, b) => a + b, 0)).toBe(100_000_000);
  });
});

describe('конвейер книги', () => {
  const plan = { config: DEFAULT_CONFIG, from: 0, rounds: 60_000, taskSize: 7_000, maxRequests: SIMULATOR_MAX_REQUESTS };

  it('байты книги не зависят от числа потоков: 1 и 3 потока, малый прообраз', async () => {
    const single = encodeBook(selectBook(prototypeInProcess(plan, 40).collector).records);
    const threaded = encodeBook(selectBook((await prototype(plan, 3, 40)).collector).records);
    expect(threaded).toStrictEqual(single);
    expect(single.length).toBeGreaterThan(18 + 12 * 100);
  }, 60_000);
});
