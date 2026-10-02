import { describe, expect, it } from 'vitest';
import { RECORD_LIMIT, RESUME_LIMIT, checkFairness, checkKey, checkRound, checkRoundCore, checkSecret, checkWallet, isResumableSeq, isSeq } from '../../../src/server/records.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';

// Гарды записей IndexedDB: каждое правило — своя литеральная поломка с точным текстом проблемы.

const SMALL = fixtureRound('small-win');

const WALLET = { id: 'main', balanceMinor: 99_900, activeRoundId: 'r7', nextSeq: 8, revision: 12, resetSeq: 3 };
const ROUND = {
  roundId: 'r7',
  seq: 7,
  idempotencyKey: 'k7',
  betMinor: 100,
  seed: 0,
  payX100: 95,
  winMinor: 95,
  events: SMALL.events,
  createdAt: 1,
  status: 'active',
  balanceAfterBet: 99_900,
  balanceAfterEnd: null,
};
const CLOSED = { ...ROUND, status: 'closed', balanceAfterEnd: 99_995 };
const KEY = { key: 'k7', roundId: 'r7', betMinor: 100 };
const COMMITMENT = 'ab'.repeat(32);
const BOOK = { ...ROUND, source: 'book', bookIndex: 79_999, nonce: 0, commitment: COMMITMENT, clientSeed: 'player1' };
const FORCED = { ...ROUND, source: 'forced', bookIndex: null, nonce: null, commitment: null, clientSeed: null };
const FAIRNESS = { id: 'main', commitment: COMMITMENT, clientSeed: 'player1', nonce: 3 };
const SECRET = { commitment: COMMITMENT, secret: 'cd'.repeat(32), createdAt: 1, revealedAt: null };

describe('граница записей', () => {
  it('2^52 — независимо от кода: 4 503 599 627 370 496', () => {
    expect(RECORD_LIMIT).toBe(2 ** 52);
  });

  it('граница продолжения счёта — 2^51: 2 251 799 813 685 248', () => {
    expect(RESUME_LIMIT).toBe(2 ** 51);
  });
});

describe('seq: безопасное целое в границах', () => {
  it.each([1.0000000000000004, 7.5, 0.5])('seq %s — раунд испорчен', (seq) => {
    expect(checkRoundCore({ ...ROUND, seq })).toBe('раунд: seq или betMinor — не положительные целые до 2^52');
  });

  it.each([1.0000000000000004, 7.5, 0.5])('nextSeq %s — кошелёк испорчен', (nextSeq) => {
    expect(checkWallet({ ...WALLET, nextSeq, resetSeq: 0.5 })).toBe('кошелёк: nextSeq или resetSeq не по порядку');
  });

  it('isSeq — до 2^52, isResumableSeq — до 2^51; дробное, 2^53 и не число — нет', () => {
    const values: unknown[] = [1, 2 ** 51, 2 ** 51 + 1, 2 ** 52, 2 ** 52 + 1, 2 ** 53, 0, 7.5, 1.0000000000000004, '7', Number.POSITIVE_INFINITY];
    expect(values.map((value) => [isSeq(value), isResumableSeq(value)])).toStrictEqual([
      [true, true],
      [true, true],
      [true, false],
      [true, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });
});

describe('checkWallet', () => {
  it.each([
    [WALLET, null],
    [{ ...WALLET, activeRoundId: null, balanceMinor: 0, revision: 0, resetSeq: 8 }, null],
    [{ ...WALLET, balanceMinor: 2 ** 52, nextSeq: 2 ** 52, revision: 2 ** 52 }, null],
    ['main', 'кошелёк — не объект'],
    [{ ...WALLET, id: 'other' }, 'кошелёк: чужой id'],
    [{ ...WALLET, balanceMinor: -1 }, 'кошелёк: balanceMinor — не целое до 2^52'],
    [{ ...WALLET, balanceMinor: 2 ** 52 + 1 }, 'кошелёк: balanceMinor — не целое до 2^52'],
    [{ ...WALLET, activeRoundId: '' }, 'кошелёк: activeRoundId — не id'],
    [{ ...WALLET, nextSeq: 0 }, 'кошелёк: nextSeq или resetSeq не по порядку'],
    [{ ...WALLET, nextSeq: 2 ** 52 + 1 }, 'кошелёк: nextSeq или resetSeq не по порядку'],
    [{ ...WALLET, resetSeq: 0 }, 'кошелёк: nextSeq или resetSeq не по порядку'],
    [{ ...WALLET, resetSeq: 9 }, 'кошелёк: nextSeq или resetSeq не по порядку'],
    [{ ...WALLET, revision: -1 }, 'кошелёк: revision — не целое до 2^52'],
    [{ ...WALLET, revision: 2 ** 52 + 1 }, 'кошелёк: revision — не целое до 2^52'],
  ])('%j → %s', (wallet, problem) => {
    expect(checkWallet(wallet)).toBe(problem);
  });
});

describe('checkRoundCore и checkRound', () => {
  it.each([
    [ROUND, null],
    [CLOSED, null],
    [{ ...ROUND, events: 'испорчено' }, null],
    [[], 'раунд — не объект'],
    [{ ...ROUND, roundId: 'r 7' }, 'раунд: roundId или ключ — не id'],
    [{ ...ROUND, idempotencyKey: '' }, 'раунд: roundId или ключ — не id'],
    [{ ...ROUND, seq: 0 }, 'раунд: seq или betMinor — не положительные целые до 2^52'],
    [{ ...ROUND, seq: 2 ** 52 + 1 }, 'раунд: seq или betMinor — не положительные целые до 2^52'],
    [{ ...ROUND, betMinor: 0 }, 'раунд: seq или betMinor — не положительные целые до 2^52'],
    [{ ...ROUND, seed: -1 }, 'раунд: сид — не u32'],
    [{ ...ROUND, seed: 2 ** 32 }, 'раунд: сид — не u32'],
    [{ ...ROUND, payX100: 0.5 }, 'раунд: payX100 или winMinor — не целые до 2^52'],
    [{ ...ROUND, winMinor: 2 ** 52 + 1 }, 'раунд: payX100 или winMinor — не целые до 2^52'],
    [{ ...ROUND, createdAt: -1 }, 'раунд: createdAt — не целое'],
    [{ ...ROUND, balanceAfterBet: -1 }, 'раунд: balanceAfterBet — не целое до 2^52'],
    [{ ...ROUND, balanceAfterEnd: 99_995 }, 'раунд: у активного есть balanceAfterEnd'],
    [{ ...CLOSED, balanceAfterEnd: 99_994 }, 'раунд: balanceAfterEnd ≠ balanceAfterBet + winMinor'],
    [{ ...CLOSED, balanceAfterEnd: null }, 'раунд: balanceAfterEnd ≠ balanceAfterBet + winMinor'],
    [{ ...ROUND, status: 'done' }, 'раунд: статус — не active и не closed'],
  ])('checkRoundCore %#', (round, problem) => {
    expect(checkRoundCore(round)).toBe(problem);
  });

  it.each([
    [ROUND, null],
    [{ ...ROUND, events: 'испорчено' }, 'раунд: события — не непустой массив'],
    [{ ...ROUND, events: SMALL.events.slice(0, -1) }, 'раунд: раунд без end'],
    [{ ...ROUND, payX100: 36 }, 'раунд: payX100 не равен итогу end'],
    [{ ...ROUND, seed: 'x' }, 'раунд: сид — не u32'],
  ])('checkRound %#', (round, problem) => {
    expect(checkRound(round)).toBe(problem);
  });
});

describe('поля честности раунда v2', () => {
  it.each([
    [BOOK, null],
    [{ ...BOOK, bookIndex: 0, nonce: 2 ** 52 }, null],
    [FORCED, null],
    [{ ...FORCED, source: 'live' }, null],
    [{ ...ROUND, bookIndex: null }, 'раунд: поля честности без source'],
    [{ ...ROUND, nonce: null }, 'раунд: поля честности без source'],
    [{ ...ROUND, commitment: null }, 'раунд: поля честности без source'],
    [{ ...ROUND, clientSeed: null }, 'раунд: поля честности без source'],
    [{ ...BOOK, bookIndex: -1 }, 'раунд: bookIndex — не индекс книги'],
    [{ ...BOOK, bookIndex: 80_000 }, 'раунд: bookIndex — не индекс книги'],
    [{ ...BOOK, nonce: -1 }, 'раунд: nonce — не целое до 2^52'],
    [{ ...BOOK, nonce: 2 ** 52 + 1 }, 'раунд: nonce — не целое до 2^52'],
    [{ ...BOOK, commitment: 'AB'.repeat(32) }, 'раунд: обязательство или сид игрока не по формату'],
    [{ ...BOOK, clientSeed: 'a:b' }, 'раунд: обязательство или сид игрока не по формату'],
    [{ ...FORCED, source: 'magic' }, 'раунд: source — не book, forced или live'],
    [{ ...FORCED, bookIndex: 3 }, 'раунд: у раунда не из книги есть поля честности'],
    [{ ...FORCED, nonce: 0 }, 'раунд: у раунда не из книги есть поля честности'],
    [{ ...FORCED, commitment: COMMITMENT }, 'раунд: у раунда не из книги есть поля честности'],
    [{ ...FORCED, clientSeed: 'player1' }, 'раунд: у раунда не из книги есть поля честности'],
  ])('checkRoundCore %#', (round, problem) => {
    expect(checkRoundCore(round)).toBe(problem);
  });
});

describe('checkFairness и checkSecret', () => {
  it.each([
    [FAIRNESS, null],
    [{ ...FAIRNESS, nonce: 2 ** 52 }, null],
    [[], 'честность — не объект'],
    [{ ...FAIRNESS, id: 'other' }, 'честность: чужой id'],
    [{ ...FAIRNESS, commitment: 'ab' }, 'честность: обязательство — не 64 знака hex'],
    [{ ...FAIRNESS, clientSeed: '' }, 'честность: сид игрока не по формату'],
    [{ ...FAIRNESS, nonce: -1 }, 'честность: nonce — не целое до 2^52'],
    [{ ...FAIRNESS, nonce: 2 ** 52 + 1 }, 'честность: nonce — не целое до 2^52'],
  ])('checkFairness %#', (fairness, problem) => {
    expect(checkFairness(fairness)).toBe(problem);
  });

  it.each([
    [SECRET, null],
    [{ ...SECRET, createdAt: 0, revealedAt: 0 }, null],
    ['секрет', 'секрет — не объект'],
    [{ ...SECRET, commitment: 'ab' }, 'секрет: обязательство или секрет — не 64 знака hex'],
    [{ ...SECRET, secret: 'CD'.repeat(32) }, 'секрет: обязательство или секрет — не 64 знака hex'],
    [{ ...SECRET, createdAt: -1 }, 'секрет: createdAt — не целое'],
    [{ ...SECRET, revealedAt: -1 }, 'секрет: revealedAt — не целое и не null'],
    [{ ...SECRET, revealedAt: '5' }, 'секрет: revealedAt — не целое и не null'],
  ])('checkSecret %#', (secret, problem) => {
    expect(checkSecret(secret)).toBe(problem);
  });
});

describe('checkKey', () => {
  it.each([
    [KEY, null],
    [null, 'ключ — не объект'],
    [{ ...KEY, key: '' }, 'ключ: key или roundId — не id'],
    [{ ...KEY, roundId: 7 }, 'ключ: key или roundId — не id'],
    [{ ...KEY, betMinor: 0 }, 'ключ: betMinor — не положительное целое до 2^52'],
  ])('%j → %s', (key, problem) => {
    expect(checkKey(key)).toBe(problem);
  });
});
