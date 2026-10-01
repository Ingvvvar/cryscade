import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { ControllerSnapshot } from '../../src/client/index.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { decodeBook, type Book } from '../../src/server/book.ts';
import { SeededRounds, type PlayedRound } from '../../src/server/seeded-rounds.ts';
import { BOOK_DIR, findBook } from '../../tools/books/files.ts';
import { gameSnapshot, readStorage, reconciled, replays, sentBodies, waitForState } from '../support/game-page.ts';
import { collectConsole, type ProbeWindow } from '../support/page-probe.ts';

// Повтор по ссылке (§7, фаза 6) в чистом профиле — Chromium и WebKit. ?replay=book:<index> — запись книги: события
// считает движок браузера (V8 или JavaScriptCore) по сиду записи, и они равны литералу, посчитанному в Node, —
// детерминизм между движками JS. ?replay=round:<id> — раунд своей истории. Повтор не шлёт authenticate, не двигает
// деньги и записи; плашка «Повтор», спин выключен, выход — обычный запуск.

/** Последняя запись книги — самый крупный выигрыш: фриспины, три ретриггера и кап. */
const CAP_INDEX = 58_353;
/** SHA-256 JSON событий записи CAP_INDEX: движок в Node по её сиду 97364531 и node:crypto — посчитан, когда писался тест. */
const CAP_EVENTS_SHA256 = 'c3274ca6fd3d27d1359dd5a346670b6882c53ca253ab4a7c195794b5a4d582da';
/**
 * Вся книга: у каждой записи — SHA-256 JSON [индекс, payX100, события], итог — SHA-256 склейки этих hex по порядку.
 * Движок в Node, посчитан, когда писался тест.
 */
const BOOK_EVENTS_SHA256 = '517c234da401e367c926502fc0616cb964772ed95dd4899f52e269011b0ddfb9';

function sha256(events: unknown): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

function localBook(): Book {
  const read = decodeBook(gunzipSync(readFileSync(`${BOOK_DIR}/${findBook()}`)), 500_000);
  if (!read.ok) throw new Error(read.problem);
  return read.book;
}

/** Запись книги, переигранная движком в Node. */
function nodeRecord(index: number): { readonly seed: number; readonly played: PlayedRound } {
  const { seed } = localBook().record(index);
  return { seed, played: new SeededRounds(DEFAULT_CONFIG, 100_000).play(seed) };
}

async function replayEnded(page: Page, roundId: string): Promise<ControllerSnapshot> {
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__cryscadeProbe?.game()?.state ?? null), { timeout: 20_000, message: 'повтор не дошёл до конца' })
    .toStrictEqual({ name: 'replaying', stage: 'done', roundId });
  return gameSnapshot(page);
}

function locks(page: Page): Promise<{ held: string[]; pending: string[] }> {
  return page.evaluate(async () => {
    const state = await navigator.locks.query();
    return { held: (state.held ?? []).map((lock) => lock.name ?? ''), pending: (state.pending ?? []).map((lock) => lock.name ?? '') };
  });
}

interface RawRound {
  readonly roundId: string;
  readonly seed: number;
  readonly betMinor: number;
  readonly winMinor: number;
  readonly events: unknown[];
}

test('запись книги: события движка браузера — литерал из Node; ни authenticate, ни кошелька; плашка «Повтор», спин выключен; «Грати» — обычный запуск', async ({ page }) => {
  const { problems } = collectConsole(page);
  const node = nodeRecord(CAP_INDEX);
  expect([node.seed, node.played.payX100, sha256(node.played.events)]).toStrictEqual([97_364_531, 500_000, CAP_EVENTS_SHA256]);
  await page.goto(`./?replay=book:${String(CAP_INDEX)}&autoskip=1`);
  const done = await replayEnded(page, `book-${String(CAP_INDEX)}`);
  const [reply] = await replays(page);
  expect(sha256((reply as { result?: { events?: unknown } }).result?.events)).toBe(CAP_EVENTS_SHA256);
  expect(reply).toStrictEqual({
    ok: true,
    result: { roundId: null, bookIndex: CAP_INDEX, betMinor: 100, payX100: 500_000, winMinor: 500_000, events: node.played.events },
  });
  expect(await sentBodies(page)).toStrictEqual([{ type: 'replay' }]);
  expect([done.mode, done.balanceMinor, done.betMinor, done.winMinor]).toStrictEqual(['replay', null, 100, 500_000]);
  await expect(page.locator('[data-notice="replay"]')).toContainText('Повтор раунду');
  await expect(page.getByTestId('balance')).toHaveText('—');
  await expect(page.getByRole('button', { name: 'Спін' })).toBeDisabled();
  expect(await readStorage(page)).toStrictEqual({ wallet: null, rounds: [], keys: 0, quarantine: 0 });
  expect(await locks(page)).toStrictEqual({ held: [], pending: [] });
  await page.locator('[data-notice="replay"]').getByRole('link', { name: 'Грати' }).click();
  await expect(page).toHaveURL(/\/cryscade\/\?autoskip=1$/);
  const start = await waitForState(page, 'idle');
  expect([start.mode, start.balanceMinor]).toStrictEqual(['play', 100_000]);
  expect(problems).toEqual([]);
});

test('раунд своей истории: те же события, что в IndexedDB и у движка Node по сиду записи; деньги и записи не двигаются', async ({ page }) => {
  const { problems } = collectConsole(page);
  await page.goto('./?autoskip=1');
  await waitForState(page, 'idle');
  await page.keyboard.press('Space');
  await expect.poll(async () => (await readStorage(page)).rounds.filter((round) => round.status === 'closed').length).toBe(1);
  await waitForState(page, 'idle');
  const before = await readStorage(page);
  const round = before.rounds[0] as unknown as RawRound;
  const node = new SeededRounds(DEFAULT_CONFIG, 100_000).play(round.seed);
  expect(round.events).toStrictEqual(node.events);
  await page.goto(`./?replay=round:${round.roundId}&autoskip=1`);
  const done = await replayEnded(page, round.roundId);
  expect(await replays(page)).toStrictEqual([
    {
      ok: true,
      result: { roundId: round.roundId, bookIndex: null, betMinor: round.betMinor, payX100: node.payX100, winMinor: round.winMinor, events: node.events },
    },
  ]);
  expect(await sentBodies(page)).toStrictEqual([{ type: 'replay' }]);
  expect([done.mode, done.balanceMinor, done.betMinor, done.winMinor]).toStrictEqual(['replay', null, round.betMinor, round.winMinor]);
  expect(await readStorage(page)).toStrictEqual(before);
  expect(await locks(page)).toStrictEqual({ held: [], pending: [] });
  await page.locator('[data-notice="replay"]').getByRole('link', { name: 'Грати' }).click();
  const start = await waitForState(page, 'idle');
  expect([start.mode, start.balanceMinor]).toStrictEqual(['play', reconciled(before)]);
  expect(problems).toEqual([]);
});

test('ссылка в никуда: раунда нет в истории браузера, записи нет в книге — экран «повтору нет» с «Грати»; кривая ссылка — обычный запуск', async ({ page }) => {
  const { problems } = collectConsole(page);
  for (const link of ['round:zz9', 'book:79999']) {
    await page.goto(`./?replay=${link}`);
    const failed = await waitForState(page, 'error');
    expect([failed.mode, failed.state]).toStrictEqual(['replay', { name: 'error', kind: 'missing', retry: null, holdsLock: false }]);
    await expect(page.locator('.status-screen')).toContainText('За цим посиланням повтору немає');
    expect(await sentBodies(page)).toStrictEqual([{ type: 'replay' }]);
  }
  await page.locator('.status-screen').getByRole('link', { name: 'Грати' }).click();
  await expect(page).toHaveURL(/\/cryscade\/$/);
  expect((await waitForState(page, 'idle')).mode).toBe('play');
  await page.goto('./?replay=book:01');
  expect((await waitForState(page, 'idle')).mode).toBe('play');
  expect(problems).toEqual([]);
});

test('вся книга: события и итог каждой из 58 354 записей в движке браузера побайтно равны Node', async ({ page }) => {
  test.setTimeout(180_000);
  const { problems } = collectConsole(page);
  const book = localBook();
  const rounds = new SeededRounds(DEFAULT_CONFIG, 100_000);
  const expected = Array.from({ length: book.size }, (_, index) => {
    const played = rounds.play(book.record(index).seed);
    return sha256([index, played.payX100, played.events]);
  });
  expect(createHash('sha256').update(expected.join('')).digest('hex')).toBe(BOOK_EVENTS_SHA256);
  await page.goto('./?replay=book:0&autoskip=1');
  await replayEnded(page, 'book-0');
  // Отдельный воркер той же сборки — тот же движок браузера. Запросы replay пачками; дайджест каждой записи — WebCrypto.
  const digests = await page.evaluate(async (size) => {
    const url = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/assets\/worker-[\w-]+\.js$/.test(name));
    if (url === undefined) throw new Error('воркер не найден');
    const worker = new Worker(url, { type: 'module' });
    const encoder = new TextEncoder();
    const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const out: string[] = [];
    const CHUNK = 500;
    for (let from = 0; from < size; from += CHUNK) {
      const to = Math.min(size, from + CHUNK);
      const replies = new Map<number, unknown>();
      await new Promise<void>((resolve) => {
        worker.onmessage = (event: MessageEvent<{ id: number; body: unknown }>) => {
          replies.set(event.data.id, event.data.body);
          if (replies.size === to - from) resolve();
        };
        for (let index = from; index < to; index++) worker.postMessage({ v: 1, id: index + 1, body: { type: 'replay', book: index } });
      });
      for (let index = from; index < to; index++) {
        const result = (replies.get(index + 1) as { result?: { payX100?: unknown; events?: unknown } } | undefined)?.result;
        out.push(hex(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([index, result?.payX100 ?? null, result?.events ?? null])))));
      }
    }
    worker.terminate();
    return out;
  }, book.size);
  expect(digests).toHaveLength(58_354);
  expect(expected.flatMap((digest, index) => (digests[index] === digest ? [] : [index]))).toStrictEqual([]);
  expect(createHash('sha256').update(digests.join('')).digest('hex')).toBe(BOOK_EVENTS_SHA256);
  expect(problems).toEqual([]);
});
