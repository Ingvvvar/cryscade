import { describe, expect, it } from 'vitest';
import {
  checkError,
  checkRequestBody,
  checkResult,
  checkRoundView,
  checkWalletChanged,
  parseRequest,
  parseResponse,
  requestEnvelope,
  responseEnvelope,
} from '../../../src/protocol/index.ts';
import { fixtureRound } from '../../support/fixture-rounds.ts';

// Конверт, сообщения и ошибки протокола v1 (§6.1): литеральные случаи на каждое поле гарда.

const SMALL = fixtureRound('small-win');
const ROUND = { roundId: 'r1', betMinor: 100, payX100: 35, winMinor: 35, events: SMALL.events };
const GRID = new Array<number>(49).fill(3);
const CONFIG = { betLevelsMinor: [20, 40, 100], capX100: 500_000 };
const WALLET = { balanceMinor: 99_900, revision: 7, notice: null };
const AUTH = { balanceMinor: 100_000, config: CONFIG, activeRound: null, idleGrid: GRID, notice: null, wallet: WALLET };

describe('parseRequest', () => {
  it('годный конверт', () => {
    const body = { type: 'play', betMinor: 20, idempotencyKey: 'k-1_A' };
    expect(parseRequest({ v: 1, id: 7, body })).toStrictEqual({ ok: true, id: 7, body });
    expect(parseRequest(requestEnvelope(0, { type: 'authenticate' }))).toStrictEqual({ ok: true, id: 0, body: { type: 'authenticate' } });
  });

  it.each([
    ['не объект', null, null, 'BAD_REQUEST'],
    ['массив', [1, 2], null, 'BAD_REQUEST'],
    ['без v', { id: 3, body: { type: 'authenticate' } }, 3, 'BAD_REQUEST'],
    ['v строкой', { v: '1', id: 3, body: { type: 'authenticate' } }, 3, 'BAD_REQUEST'],
    ['без id', { v: 1, body: { type: 'authenticate' } }, null, 'BAD_REQUEST'],
    ['id дробный', { v: 1, id: 1.5, body: { type: 'authenticate' } }, null, 'BAD_REQUEST'],
    ['id отрицательный', { v: 1, id: -1, body: { type: 'authenticate' } }, null, 'BAD_REQUEST'],
    ['тело не объект', { v: 1, id: 3, body: 'authenticate' }, 3, 'BAD_REQUEST'],
    ['неизвестный тип', { v: 1, id: 3, body: { type: 'rotateSeed' } }, 3, 'BAD_REQUEST'],
  ])('%s → %s', (_what, raw, id, code) => {
    const parsed = parseRequest(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.id).toBe(id);
    expect(parsed.error.code).toBe(code);
  });

  it('чужая версия — VERSION_MISMATCH с id и нашей версией, тело не смотрится', () => {
    expect(parseRequest({ v: 2, id: 4, body: 'что угодно' })).toStrictEqual({
      ok: false,
      id: 4,
      error: { code: 'VERSION_MISMATCH', supported: 1 },
    });
  });
});

describe('checkRequestBody', () => {
  it.each([
    [{ type: 'authenticate' }, null],
    [{ type: 'resetBalance', extra: 1 }, null],
    [{ type: 'play', betMinor: 20, idempotencyKey: 'a'.repeat(64) }, null],
    [{ type: 'play', betMinor: 30, idempotencyKey: 'k' }, null],
    [{ type: 'play', betMinor: -20, idempotencyKey: 'k' }, 'play: betMinor — не целое'],
    [{ type: 'play', betMinor: 20.5, idempotencyKey: 'k' }, 'play: betMinor — не целое'],
    [{ type: 'play', betMinor: '20', idempotencyKey: 'k' }, 'play: betMinor — не целое'],
    [{ type: 'play', betMinor: 20, idempotencyKey: 'a'.repeat(65) }, 'play: idempotencyKey — не ключ'],
    [{ type: 'play', betMinor: 20, idempotencyKey: '' }, 'play: idempotencyKey — не ключ'],
    [{ type: 'play', betMinor: 20, idempotencyKey: 'ключ' }, 'play: idempotencyKey — не ключ'],
    [{ type: 'play', betMinor: 20, idempotencyKey: 'a b' }, 'play: idempotencyKey — не ключ'],
    [{ type: 'play', betMinor: 20 }, 'play: idempotencyKey — не ключ'],
    [{ type: 'endRound', roundId: 'r1' }, null],
    [{ type: 'endRound', roundId: 1 }, 'endRound: roundId — не id раунда'],
    [{ type: 'endRound' }, 'endRound: roundId — не id раунда'],
    [{}, 'неизвестный тип запроса'],
    [[], 'тело запроса — не объект'],
  ])('%j → %s', (body, problem) => {
    expect(checkRequestBody(body)).toBe(problem);
  });
});

describe('checkRoundView', () => {
  it('раунд из фикстуры годится', () => {
    expect(checkRoundView(ROUND)).toBeNull();
  });

  it.each([
    [{ ...ROUND, roundId: '' }, 'раунд: roundId — не id'],
    [{ ...ROUND, betMinor: 0 }, 'раунд: betMinor — не положительное целое'],
    [{ ...ROUND, winMinor: -1 }, 'раунд: payX100 или winMinor — не целые'],
    [{ ...ROUND, payX100: 36 }, 'раунд: payX100 не равен итогу end'],
    [{ ...ROUND, events: SMALL.events.slice(0, -1) }, 'раунд: раунд без end'],
    [{ ...ROUND, events: [] }, 'раунд: события — не непустой массив'],
    ['r1', 'раунд — не объект'],
  ])('%#', (view, problem) => {
    expect(checkRoundView(view)).toBe(problem);
  });
});

describe('checkResult', () => {
  it.each([
    ['authenticate', AUTH, null],
    ['authenticate', { ...AUTH, activeRound: ROUND, notice: 'reset' }, null],
    ['authenticate', { ...AUTH, notice: 'volatile' }, null],
    ['authenticate', { ...AUTH, balanceMinor: 1.5 }, 'authenticate: balanceMinor — не целое'],
    ['authenticate', { ...AUTH, config: { ...CONFIG, betLevelsMinor: [40, 20] } }, 'authenticate: config: ставки не по возрастанию'],
    ['authenticate', { ...AUTH, config: { ...CONFIG, betLevelsMinor: [] } }, 'authenticate: config: ставки не по возрастанию'],
    ['authenticate', { ...AUTH, config: { ...CONFIG, capX100: 0 } }, 'authenticate: config: capX100 — не положительное целое'],
    ['authenticate', { ...AUTH, config: null }, 'authenticate: config — не объект'],
    ['authenticate', { ...AUTH, activeRound: { ...ROUND, payX100: 0 } }, 'authenticate: активный раунд: payX100 не равен итогу end'],
    ['authenticate', { ...AUTH, activeRound: undefined }, 'authenticate: активный раунд — не объект'],
    ['authenticate', { ...AUTH, idleGrid: GRID.slice(1) }, 'authenticate: idleGrid — не 49 символов'],
    ['authenticate', { ...AUTH, notice: 'broken' }, 'authenticate: неизвестное уведомление'],
    ['authenticate', { ...AUTH, wallet: { ...WALLET, revision: 0, notice: 'reset' } }, null],
    ['authenticate', { ...AUTH, wallet: undefined }, 'authenticate: wallet — не объект'],
    ['authenticate', { ...AUTH, wallet: { ...WALLET, revision: -1 } }, 'authenticate: wallet: balanceMinor или revision — не целые'],
    ['authenticate', { ...AUTH, wallet: { ...WALLET, notice: 'volatile' } }, 'authenticate: wallet: неизвестное уведомление'],
    ['play', { round: ROUND, balanceMinor: 99_900, wallet: WALLET }, null],
    ['play', { round: ROUND, balanceMinor: -1, wallet: WALLET }, 'play: balanceMinor — не целое'],
    ['play', { round: { ...ROUND, events: [{ t: 'end', payX100: 35 }] }, balanceMinor: 0, wallet: WALLET }, 'play: раунд: событие 0: end не на месте'],
    ['play', { round: ROUND, balanceMinor: 99_900 }, 'play: wallet — не объект'],
    ['play', { round: ROUND, balanceMinor: 99_900, wallet: { ...WALLET, balanceMinor: 0.5 } }, 'play: wallet: balanceMinor или revision — не целые'],
    ['endRound', { balanceMinor: 99_935, wallet: WALLET }, null],
    ['endRound', { balanceMinor: '99935', wallet: WALLET }, 'endRound: balanceMinor — не целое'],
    ['endRound', { balanceMinor: 99_935, wallet: { ...WALLET, revision: '7' } }, 'endRound: wallet: balanceMinor или revision — не целые'],
    ['endRound', { balanceMinor: 99_935, wallet: [] }, 'endRound: wallet — не объект'],
    ['resetBalance', { balanceMinor: 100_000, wallet: { balanceMinor: 100_000, revision: 1, notice: null } }, null],
    ['resetBalance', { wallet: WALLET }, 'resetBalance: balanceMinor — не целое'],
    ['resetBalance', { balanceMinor: 100_000, wallet: { ...WALLET, notice: 'ok' } }, 'resetBalance: wallet: неизвестное уведомление'],
    ['play', 'ok', 'результат — не объект'],
  ] as const)('%s %#', (type, result, problem) => {
    expect(checkResult(type, result)).toBe(problem);
  });
});

describe('checkError', () => {
  it.each([
    [{ code: 'INSUFFICIENT_FUNDS', balanceMinor: 10 }, null],
    [{ code: 'INSUFFICIENT_FUNDS' }, 'INSUFFICIENT_FUNDS: balanceMinor — не целое'],
    [{ code: 'ROUND_ACTIVE', roundId: 'r1' }, null],
    [{ code: 'ROUND_ACTIVE', roundId: null }, 'ROUND_ACTIVE: roundId — не id'],
    [{ code: 'ROUND_NOT_FOUND', roundId: 'r1' }, null],
    [{ code: 'ROUND_NOT_FOUND', roundId: 'r 1' }, 'ROUND_NOT_FOUND: roundId — не id'],
    [{ code: 'INVALID_BET', betMinor: 30 }, null],
    [{ code: 'INVALID_BET', betMinor: -30 }, 'INVALID_BET: betMinor — не целое'],
    [{ code: 'IDEMPOTENCY_CONFLICT' }, null],
    [{ code: 'BAD_REQUEST', message: 'нет' }, null],
    [{ code: 'BAD_REQUEST' }, 'BAD_REQUEST: message — не строка'],
    [{ code: 'INTERNAL', message: 'сторож' }, null],
    [{ code: 'INTERNAL', message: 5 }, 'INTERNAL: message — не строка'],
    [{ code: 'VERSION_MISMATCH', supported: 1 }, null],
    [{ code: 'VERSION_MISMATCH', supported: 0 }, 'VERSION_MISMATCH: supported — не версия'],
    [{ code: 'TEAPOT' }, 'неизвестный код ошибки'],
    ['INTERNAL', 'ошибка — не объект'],
  ])('%j → %s', (error, problem) => {
    expect(checkError(error)).toBe(problem);
  });
});

describe('parseResponse', () => {
  it('результат под тип запроса', () => {
    const result = { balanceMinor: 99_935, wallet: { balanceMinor: 99_935, revision: 8, notice: null } };
    const raw = responseEnvelope(5, { ok: true, result });
    expect(parseResponse('endRound', raw)).toStrictEqual({ kind: 'result', id: 5, result });
  });

  it('ошибка — с id или без, если запрос не прочитан', () => {
    const error = { code: 'BAD_REQUEST', message: 'конверт — не объект' } as const;
    expect(parseResponse('play', { v: 1, id: null, body: { ok: false, error } })).toStrictEqual({ kind: 'error', id: null, error });
    expect(parseResponse('play', { v: 1, id: 9, body: { ok: false, error } })).toStrictEqual({ kind: 'error', id: 9, error });
  });

  it('чужая версия — предложить перезагрузку', () => {
    expect(parseResponse('authenticate', { v: 2, id: 1, body: {} })).toStrictEqual({ kind: 'version', v: 2 });
  });

  it.each([
    ['не объект', 'ok', 'конверт — не объект'],
    ['v строкой', { v: '1', id: 1, body: { ok: true, result: {} } }, 'v конверта — не целое'],
    ['id дробный', { v: 1, id: 0.5, body: { ok: true, result: {} } }, 'id конверта — не целое'],
    ['тело не объект', { v: 1, id: 1, body: null }, 'тело ответа — не объект'],
    ['результат без id', { v: 1, id: null, body: { ok: true, result: { balanceMinor: 1 } } }, 'результат без id'],
    ['ok не булево', { v: 1, id: 1, body: { ok: 'true', result: { balanceMinor: 1 } } }, 'ok ответа — не булево'],
    ['результат не того типа', { v: 1, id: 1, body: { ok: true, result: { balanceMinor: 1 } } }, 'play: раунд — не объект'],
    ['испорченная ошибка', { v: 1, id: 1, body: { ok: false, error: { code: 'ROUND_ACTIVE' } } }, 'ROUND_ACTIVE: roundId — не id'],
    [
      'испорченные события',
      { v: 1, id: 1, body: { ok: true, result: { round: { ...ROUND, events: SMALL.events.slice(1) }, balanceMinor: 0, wallet: WALLET } } },
      'play: раунд: событие 0: win не после сетки',
    ],
  ])('%s → invalid', (_what, raw, problem) => {
    expect(parseResponse('play', raw)).toStrictEqual({ kind: 'invalid', problem });
  });
});

describe('checkWalletChanged', () => {
  const MESSAGE = { v: 1, type: 'walletChanged', balanceMinor: 99_900, activeRoundId: 'r1', revision: 3, notice: null };

  it.each([
    [MESSAGE, null],
    [{ ...MESSAGE, activeRoundId: null, notice: 'reset' }, null],
    [{ ...MESSAGE, v: 2 }, 'оповещение — не walletChanged v1'],
    [{ ...MESSAGE, type: 'other' }, 'оповещение — не walletChanged v1'],
    [{ ...MESSAGE, revision: -1 }, 'оповещение: balanceMinor или revision — не целые'],
    [{ ...MESSAGE, balanceMinor: 0.5 }, 'оповещение: balanceMinor или revision — не целые'],
    [{ ...MESSAGE, activeRoundId: '' }, 'оповещение: activeRoundId — не id'],
    [{ ...MESSAGE, notice: 'volatile' }, 'оповещение: неизвестное уведомление'],
    [null, 'оповещение — не объект'],
  ])('%#', (message, problem) => {
    expect(checkWalletChanged(message)).toBe(problem);
  });
});
