import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { type Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { decodeBook, type Book } from '../../src/server/book.ts';
import { BOOK_DIR, findBook } from '../../tools/books/files.ts';
import { blankOnOrigin, gameSnapshot, readStorage, reconciled, sentBodies, waitForState } from '../support/game-page.ts';
import { fixtureRound } from '../support/fixture-rounds.ts';
import { collectConsole } from '../support/page-probe.ts';

// Книга и честность в настоящем воркере (§5, §7, фаза 6): раунд выбран WebCrypto-HMAC из книги — тот же индекс
// считается здесь, в Node: node:crypto, первые 8 байт big-endian, отбрасывание у границы, перебор накопленных весов;
// секрет и сид — из IndexedDB игры. Битая книга — INTERNAL с понятным текстом, следующая загрузка — игра. База v1 с
// деньгами поднимается до v2: баланс и раунды целы, старый раунд — живой, «до честности».

const BET = 100;

function localBook(): Book {
  const read = decodeBook(gunzipSync(readFileSync(`${BOOK_DIR}/${findBook()}`)), 500_000);
  if (!read.ok) throw new Error(read.problem);
  return read.book;
}

/** Индекс книги для (секрет, сид игрока, nonce) — своим путём, мимо server/fairness.ts. */
function nodeIndex(book: Book, secret: string, clientSeed: string, nonce: number): number {
  const total = BigInt(book.total);
  const limit = (2n ** 64n / total) * total;
  for (let counter = 0; counter < 64; counter++) {
    const value = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${clientSeed}:${String(nonce)}:${String(counter)}`).digest().readBigUInt64BE(0);
    if (value >= limit) continue;
    const point = Number(value % total);
    let running = 0;
    for (let index = 0; index < book.size; index++) {
      running += book.record(index).weight;
      if (running > point) return index;
    }
  }
  throw new Error('не выбрано');
}

interface FairnessStores {
  readonly version: number;
  readonly stores: readonly string[];
  readonly rounds: readonly Record<string, unknown>[];
  readonly fairness: { readonly commitment: string; readonly clientSeed: string; readonly nonce: number } | null;
  readonly secrets: readonly { readonly commitment: string; readonly secret: string; readonly revealedAt: number | null }[];
}

function readFairness(page: Page): Promise<FairnessStores> {
  return page.evaluate(
    () =>
      new Promise<FairnessStores>((resolve, reject) => {
        const request = indexedDB.open('cryscade');
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['rounds', 'fairness', 'secrets'], 'readonly');
          const rounds = tx.objectStore('rounds').getAll();
          const fairness = tx.objectStore('fairness').get('main');
          const secrets = tx.objectStore('secrets').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              version: db.version,
              stores: [...db.objectStoreNames],
              rounds: rounds.result as Record<string, unknown>[],
              fairness: (fairness.result as FairnessStores['fairness'] | undefined) ?? null,
              secrets: secrets.result as FairnessStores['secrets'],
            });
          };
        };
      }),
  );
}

/** Запрос в отдельный воркер той же сборки — ответ сервера как есть (текст ошибки игроку не показывается). */
async function askWorker(page: Page, body: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async (message) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/assets\/worker-[\w-]+\.js$/.test(name));
    if (url === undefined) throw new Error('воркер не найден');
    const worker = new Worker(url, { type: 'module' });
    const reply = await new Promise<unknown>((resolve) => {
      worker.onmessage = (event: MessageEvent<{ id: number; body: unknown }>) => {
        if (event.data.id === 1) resolve(event.data.body);
      };
      worker.postMessage({ v: 1, id: 1, body: message });
    });
    worker.terminate();
    return reply;
  }, body);
}

test('раунд из книги: индекс, сид и итог — те, что Node считает по секрету и сиду из IndexedDB; книга качается один раз после первого кадра', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await expect.poll(async () => (await sentBodies(page)).filter((body) => body.type === 'loadBook').length, { message: 'книга не запрошена' }).toBe(1);
  const book = localBook();
  for (let round = 0; round < 3; round++) {
    await page.keyboard.press('Space');
    await expect.poll(async () => (await readStorage(page)).rounds.filter((item) => item.status === 'closed').length).toBe(round + 1);
    await waitForState(page, 'idle');
  }
  const stored = await readFairness(page);
  expect(stored.fairness?.nonce).toBe(3);
  const secret = stored.secrets.find((item) => item.commitment === stored.fairness?.commitment);
  expect(secret?.revealedAt).toBeNull();
  expect(createHash('sha256').update(Buffer.from(secret?.secret ?? '', 'hex')).digest('hex')).toBe(stored.fairness?.commitment);
  const rounds = [...stored.rounds].sort((a, b) => Number(a['seq']) - Number(b['seq']));
  expect(rounds.map((item) => item['nonce'])).toStrictEqual([0, 1, 2]);
  for (const item of rounds) {
    const index = nodeIndex(book, secret?.secret ?? '', String(item['clientSeed']), Number(item['nonce']));
    expect([item['source'], item['bookIndex'], item['commitment']]).toStrictEqual(['book', index, stored.fairness?.commitment]);
    expect([item['seed'], item['payX100']]).toStrictEqual([book.record(index).seed, book.record(index).payX100]);
  }
  expect((await sentBodies(page)).filter((body) => body.type === 'loadBook')).toHaveLength(1);
  expect((await gameSnapshot(page)).balanceMinor).toBe(reconciled(await readStorage(page)));
  expect(problems).toEqual([]);
});

test('битая книга: сервер отвечает INTERNAL с понятным текстом, игрок видит экран ошибки; книга цела — «Повторити» грузит её заново и играет', async ({ page }) => {
  const { problems } = collectConsole(page);
  let corrupt = true;
  const book = readFileSync(`${BOOK_DIR}/${findBook()}`);
  // Битая — несжатые байты с одним перевёрнутым; целая — сам .gz без Content-Encoding, как его отдаёт GitHub Pages:
  // распаковывает воркер (vite preview шлёт Content-Encoding: gzip, и тогда распаковывает браузер).
  await page.route('**/books/base.v1.*.bin.gz', async (route) => {
    if (!corrupt) {
      await route.fulfill({ body: book, contentType: 'application/gzip' });
      return;
    }
    const bytes = gunzipSync(book);
    bytes[100] = (bytes[100] ?? 0) ^ 0xff;
    await route.fulfill({ body: bytes, contentType: 'application/octet-stream' });
  });
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  const answer = await askWorker(page, { type: 'loadBook' });
  expect(answer).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(JSON.stringify(answer)).toMatch(/книга исходов не загрузилась: SHA-256 [0-9a-f]{12}… не сошёлся с эталоном сборки [0-9a-f]{12}…/);
  await page.keyboard.press('Space');
  const failed = await waitForState(page, 'error');
  expect(failed.balanceMinor).toBe(100_000);
  expect((await readStorage(page)).rounds).toHaveLength(0);
  corrupt = false;
  await page.getByRole('button', { name: 'Повторити' }).click();
  await expect.poll(async () => (await readStorage(page)).rounds.filter((item) => item.status === 'closed').length).toBe(1);
  await waitForState(page, 'idle');
  const [round] = (await readFairness(page)).rounds;
  expect([round?.['source'], round?.['nonce']]).toStrictEqual(['book', 0]);
  expect(problems).toEqual([]);
});

test('миграция v1 → v2: база v1 с деньгами и раундом — игра поднимает её до v2; баланс и раунд целы, старый раунд — живой', async ({ page }) => {
  const { problems } = collectConsole(page);
  await blankOnOrigin(page);
  const small = fixtureRound('small-win');
  const old = {
    roundId: 'old1',
    seq: 1,
    idempotencyKey: 'q1',
    betMinor: BET,
    seed: 0,
    payX100: 95,
    winMinor: 95,
    events: small.events,
    createdAt: 1_790_000_000_000,
    status: 'closed',
    balanceAfterBet: 99_900,
    balanceAfterEnd: 99_995,
  };
  // Схема v1 — как её строил шаг миграции 1: кошелёк, раунды с уникальным seq, ключи с индексом раунда, карантин.
  await page.evaluate(
    (round) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('cryscade', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('wallet', { keyPath: 'id' });
          db.createObjectStore('rounds', { keyPath: 'roundId' }).createIndex('seq', 'seq', { unique: true });
          db.createObjectStore('keys', { keyPath: 'key' }).createIndex('roundId', 'roundId', { unique: false });
          db.createObjectStore('quarantine', { autoIncrement: true });
        };
        request.onerror = () => {
          reject(new Error(String(request.error)));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['wallet', 'rounds', 'keys'], 'readwrite');
          tx.objectStore('wallet').put({ id: 'main', balanceMinor: 99_995, activeRoundId: null, nextSeq: 2, revision: 2, resetSeq: 1 });
          tx.objectStore('rounds').put(round);
          tx.objectStore('keys').put({ key: 'q1', roundId: 'old1', betMinor: 100 });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            reject(new Error(String(tx.error)));
          };
        };
      }),
    old,
  );
  await page.goto('./?autoskip=1');
  const start = await waitForState(page, 'idle');
  expect([start.balanceMinor, start.notice]).toStrictEqual([99_995, null]);
  const upgraded = await readFairness(page);
  expect(upgraded.version).toBe(2);
  expect([...upgraded.stores].sort()).toStrictEqual(['fairness', 'keys', 'quarantine', 'rounds', 'secrets', 'wallet']);
  expect(upgraded.rounds).toStrictEqual([old]);
  expect(upgraded.fairness?.nonce).toBe(0);
  const history = await askWorker(page, { type: 'history', limit: 10 });
  expect(history).toMatchObject({ ok: true, result: { rounds: [{ roundId: 'old1', source: 'live', bookIndex: null, nonce: null, commitment: null, secret: null }] } });
  await page.keyboard.press('Space');
  await expect.poll(async () => (await readStorage(page)).rounds.filter((item) => item.status === 'closed').length).toBe(2);
  await waitForState(page, 'idle');
  const after = await readFairness(page);
  const fresh = after.rounds.find((item) => item['roundId'] !== 'old1');
  expect([fresh?.['source'], fresh?.['nonce'], fresh?.['seq']]).toStrictEqual(['book', 0, 2]);
  expect((await gameSnapshot(page)).balanceMinor).toBe(reconciled(await readStorage(page)));
  expect(problems).toEqual([]);
});
