// Проверка раунда (§7, docs/fairness.md): node tools/fairness/verify.ts --secret=<hex> --client-seed=<сид> --nonce=<n>
// [--commitment=<hex>] [--bet=<минимальные единицы>]. Печатает каждый шаг числами: обязательство, HMAC по counter,
// uint64 и граница, точка, индекс книги, запись, движок по её сиду и выигрыш. Код выхода 1 — что-то не сошлось.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isBetLevel } from '../../src/core/money.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { decodeBook } from '../../src/server/book.ts';
import { SeededRounds } from '../../src/server/seeded-rounds.ts';
import { BOOK_DIR, findBook } from '../books/files.ts';
import { SIMULATOR_MAX_REQUESTS } from '../math/limits.ts';
import { renderSteps, verifySteps } from './steps.ts';

function text(name: string): string | null {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const secret = text('secret') ?? '';
const clientSeed = text('client-seed') ?? '';
const nonce = Number(text('nonce') ?? 'NaN');
const commitment = text('commitment');
const betMinor = Number(text('bet') ?? '100');
if (!/^[0-9a-f]{64}$/.test(secret)) fail('--secret: 64 знака hex [0-9a-f] — раскрытый секрет сервера');
if (!/^[0-9A-Za-z]{1,64}$/.test(clientSeed)) fail('--client-seed: 1–64 знака [0-9A-Za-z]');
if (!Number.isSafeInteger(nonce) || nonce < 0) fail('--nonce: целое от 0');
if (commitment !== null && !/^[0-9a-f]{64}$/.test(commitment)) fail('--commitment: 64 знака hex [0-9a-f]');
if (!isBetLevel(betMinor)) fail('--bet: уровень ставки в минимальных единицах (20, 40, 100, …, 10000)');

const path = `${BOOK_DIR}/${findBook()}`;
const read = decodeBook(gunzipSync(readFileSync(path)), DEFAULT_CONFIG.capX100);
if (!read.ok) fail(`книга ${path}: ${read.problem}`);
const rounds = new SeededRounds(DEFAULT_CONFIG, SIMULATOR_MAX_REQUESTS);
const steps = verifySteps({ secret, clientSeed, nonce, betMinor }, read.book, {
  hmac: (key, message) => createHmac('sha256', key).update(message).digest(),
  sha256: (bytes) => createHash('sha256').update(bytes).digest(),
  play: (seed) => rounds.play(seed).payX100,
});
const report = renderSteps(steps, path, commitment);
console.log(report.lines.join('\n'));
if (!report.ok) process.exit(1);
