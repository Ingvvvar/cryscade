import { describe, expect, it } from 'vitest';
import { RECORD_LIMIT, checkKey, checkRound, checkRoundCore, checkWallet } from '../../../src/server/records.ts';
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
  payX100: 35,
  winMinor: 35,
  events: SMALL.events,
  createdAt: 1,
  status: 'active',
  balanceAfterBet: 99_900,
  balanceAfterEnd: null,
};
const CLOSED = { ...ROUND, status: 'closed', balanceAfterEnd: 99_935 };
const KEY = { key: 'k7', roundId: 'r7', betMinor: 100 };

describe('граница записей', () => {
  it('2^52 — независимо от кода: 4 503 599 627 370 496', () => {
    expect(RECORD_LIMIT).toBe(2 ** 52);
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
    [{ ...ROUND, balanceAfterEnd: 99_935 }, 'раунд: у активного есть balanceAfterEnd'],
    [{ ...CLOSED, balanceAfterEnd: 99_934 }, 'раунд: balanceAfterEnd ≠ balanceAfterBet + winMinor'],
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
