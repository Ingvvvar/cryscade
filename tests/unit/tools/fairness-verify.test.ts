import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { decodeBook, type Book } from '../../../src/server/book.ts';
import { BOOK_DIR, findBook } from '../../../tools/books/files.ts';
import { SeededRounds } from '../../../src/server/seeded-rounds.ts';
import { renderSteps, verifySteps, type Hmac, type VerifyPorts } from '../../../tools/fairness/steps.ts';
import { testBook } from '../../support/test-book.ts';

// Проверка раунда по шагам (docs/fairness.md). Пример — настоящий раунд e2e-сборки в Chromium: nonce 2, секрет раскрыт
// сменой сида. Ожидания — не из инструмента: обязательство и HMAC — вывод openssl dgst (OpenSSL 3.6.4 и LibreSSL 3.3.6
// дали одно и то же), uint64, граница и точка — Python (int(…, 16), 2**64 // W, %), индекс и накопленные веса — разбор
// файла книги на Python (struct, мимо src/server/book.ts); индекс 18298 записал и сервер игры в раунд.

const EXAMPLE = {
  secret: '6ce21799a457eefb0c1e6532af8132dc4fdf902e4ff9459c36f3088adfc5e48d',
  clientSeed: '368b3992e69d7702',
  nonce: 2,
  betMinor: 100,
} as const;
const COMMITMENT = '2e2bb4e58966f22a7cdd8eed6d6a7b4030abef3cf5b0cead067218feb9d2e8be';
const DIGEST = 'e8b522795c80453e9c45e9501b7a9509c8ef4a79f9723ef04d1fa588ac852da6';

const nodeHmac: Hmac = (key, message) => createHmac('sha256', key).update(message).digest();
const PORTS: VerifyPorts = {
  hmac: nodeHmac,
  sha256: (bytes) => createHash('sha256').update(bytes).digest(),
  play: (seed) => new SeededRounds(DEFAULT_CONFIG, 100_000).play(seed).payX100,
};

function gameBook(): Book {
  const read = decodeBook(gunzipSync(readFileSync(`${BOOK_DIR}/${findBook()}`)), DEFAULT_CONFIG.capX100);
  if (!read.ok) throw new Error(read.problem);
  return read.book;
}

describe('verifySteps', () => {
  it('раунд примера: каждый шаг — числа openssl и Python', () => {
    expect(verifySteps(EXAMPLE, gameBook(), PORTS)).toStrictEqual({
      commitment: COMMITMENT,
      records: 58_354,
      total: 6_534_666_741_287,
      quotient: '2822905',
      limit: '18446743417312778735',
      counters: [{ counter: 0, message: '368b3992e69d7702:2:0', digest: DIGEST, head: 'e8b522795c80453e', value: '16768346692222207294', point: 6_288_742_029_361 }],
      point: 6_288_742_029_361,
      index: 18_298,
      before: 6_288_699_858_027,
      after: 6_288_765_363_985,
      seed: 27_781_324,
      payX100: 360,
      weight: 65_505_958,
      enginePayX100: 360,
      betMinor: 100,
      winMinor: 360,
    });
  });

  it('выигрыш — от ставки: floor(ставка × payX100 / 100)', () => {
    expect(verifySteps({ ...EXAMPLE, betMinor: 20 }, gameBook(), PORTS).winMinor).toBe(72);
  });

  it('значение за границей — следующий counter; точка — у первого, что прошёл', () => {
    // Книга из трёх записей, W = 10: граница — floor(2^64 / 10) · 10 = 18446744073709551610; восемь байт 0xff — за ней.
    let calls = 0;
    const scripted: Hmac = (key, message) => {
      calls += 1;
      return calls === 1 ? new Uint8Array(32).fill(0xff) : nodeHmac(key, message);
    };
    const steps = verifySteps(EXAMPLE, testBook(), { ...PORTS, hmac: scripted });
    const second = createHmac('sha256', Buffer.from(EXAMPLE.secret, 'hex')).update('368b3992e69d7702:2:1').digest();
    const value = second.readBigUInt64BE(0);
    expect(steps.limit).toBe('18446744073709551610');
    expect(steps.counters.map((step) => [step.counter, step.message, step.value, step.point])).toStrictEqual([
      [0, '368b3992e69d7702:2:0', '18446744073709551615', null],
      [1, '368b3992e69d7702:2:1', value.toString(), Number(value % 10n)],
    ]);
    expect(steps.point).toBe(Number(value % 10n));
    const lines = renderSteps(steps, 'book', null).lines;
    expect(lines.filter((line) => line.includes('не меньше — следующий counter') || line.startsWith('   точка'))).toStrictEqual([
      '   граница floor(2^64 / W) · W = 1844674407370955161 · 10 = 18446744073709551610: не меньше — следующий counter',
      `   точка = ${value.toString()} mod 10 = ${String(value % 10n)}`,
    ]);
  });
});

describe('renderSteps', () => {
  const book = 'public/books/base.v1.bda29460a5ec.bin.gz';

  it('пример: строки — те, что в docs/fairness.md, вердикт — сошлось', () => {
    const doc = readFileSync('docs/fairness.md', 'utf8');
    const block = /## Всё одной командой[\s\S]*?```text\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? '';
    const report = renderSteps(verifySteps(EXAMPLE, gameBook(), PORTS), book, COMMITMENT);
    expect(report.lines.length).toBeGreaterThan(0);
    expect(report.lines.join('\n')).toBe(block);
    expect(report.ok).toBe(true);
  });

  it('чужое обязательство и расхождение движка с книгой — не сошлось; без обязательства — сверка руками', () => {
    const steps = verifySteps(EXAMPLE, gameBook(), PORTS);
    const foreign = renderSteps(steps, book, '0'.repeat(64));
    expect([foreign.ok, foreign.lines[1]]).toStrictEqual([false, `1. SHA-256(секрет) = ${COMMITMENT} — НЕ совпадает с обязательством ${'0'.repeat(64)}`]);
    const drifted = renderSteps(verifySteps(EXAMPLE, gameBook(), { ...PORTS, play: () => 361 }), book, COMMITMENT);
    expect([drifted.ok, drifted.lines.find((line) => line.startsWith('4.'))]).toStrictEqual([
      false,
      '4. запись 18298: сид 27781324, выплата 360 сотых ставки, вес 65505958; движок по сиду — 361, НЕ совпадает',
    ]);
    const open = renderSteps(steps, book, null);
    expect([open.ok, open.lines[1]]).toStrictEqual([true, `1. SHA-256(секрет) = ${COMMITMENT} — сверь с обязательством, опубликованным до раунда`]);
  });
});

describe('docs/fairness.md', () => {
  const doc = readFileSync('docs/fairness.md', 'utf8');

  it('разобранный пример в документе — те же числа', () => {
    const numbers = [
      EXAMPLE.secret,
      EXAMPLE.clientSeed,
      COMMITMENT,
      DIGEST,
      'e8b522795c80453e',
      '16768346692222207294',
      '6534666741287',
      '2822905',
      '18446743417312778735',
      '6288742029361',
      '18298',
      '6288699858027',
      '6288765363985',
      '27781324',
      '65505958',
      findBook(),
    ];
    expect(numbers.filter((number) => !doc.includes(number))).toStrictEqual([]);
    expect(numbers.length).toBeGreaterThan(0);
  });
});

describe('node tools/fairness/verify.ts', () => {
  const run = (...args: string[]): { status: number; out: string } => {
    try {
      return { status: 0, out: execFileSync('node', ['tools/fairness/verify.ts', ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { status: failed.status, out: failed.stdout + failed.stderr };
    }
  };
  const example = [`--secret=${EXAMPLE.secret}`, `--client-seed=${EXAMPLE.clientSeed}`, '--nonce=2'];

  it('пример: всё сходится — код 0, индекс, движок и выигрыш в выводе', { timeout: 30_000 }, () => {
    const { status, out } = run(...example, `--commitment=${COMMITMENT}`);
    expect(status).toBe(0);
    expect(out).toContain('совпадает с обязательством');
    expect(out).toContain('3. индекс книги 18298: накопленный вес до записи 6288699858027 ≤ точка 6288742029361 < 6288765363985 с записью');
    expect(out).toContain('движок по сиду — 360, совпадает');
    expect(out).toContain('floor(100 · 360 / 100) = 360');
    expect(out).toContain('?replay=book:18298');
  });

  it('чужое обязательство — код 1; кривой ввод — код 1 с подсказкой', { timeout: 30_000 }, () => {
    const wrong = run(...example, `--commitment=${'0'.repeat(64)}`);
    expect([wrong.status, wrong.out.includes(`НЕ совпадает с обязательством ${'0'.repeat(64)}`)]).toStrictEqual([1, true]);
    const seed = run(`--secret=${EXAMPLE.secret}`, '--client-seed=a:b', '--nonce=2');
    expect([seed.status, seed.out.includes('--client-seed: 1–64 знака [0-9A-Za-z]')]).toStrictEqual([1, true]);
    const bet = run(...example, '--bet=150');
    expect([bet.status, bet.out.includes('--bet: уровень ставки')]).toStrictEqual([1, true]);
  });
});
