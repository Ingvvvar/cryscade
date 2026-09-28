import type { RoundEvent } from '../core/model/events.ts';
import { isAscendingInts, isNat, isPositive, isRecord, isToken } from './guards.ts';
import { checkRoundEvents, isSymbolGrid } from './round-events.ts';

// Сообщения протокола v1 (§6.1): тела запросов, результаты, ошибки. Только простые данные — переживают postMessage
// и JSON. Новые сообщения и поля добавляются внутри v1; гарды проверяют известные поля и не мешают лишним.

export type RequestBody =
  | { readonly type: 'authenticate' }
  | { readonly type: 'play'; readonly betMinor: number; readonly idempotencyKey: string }
  | { readonly type: 'endRound'; readonly roundId: string }
  | { readonly type: 'resetBalance' };

export type RequestType = RequestBody['type'];

/** Раунд в ответе — всё, что нужно показу. С фазы 6 — ещё индекс книги и nonce. */
export interface RoundView {
  readonly roundId: string;
  readonly betMinor: number;
  readonly payX100: number;
  readonly winMinor: number;
  readonly events: readonly RoundEvent[];
}

/** Что клиенту знать об игре. С фазы 7 — пресет и таблица выплат. */
export interface ClientConfig {
  readonly betLevelsMinor: readonly number[];
  readonly capX100: number;
}

/** volatile — IndexedDB недоступна, игра идёт в памяти; reset — данные были испорчены, баланс восстановлен до 1000. */
export type StorageNotice = 'volatile' | 'reset';

export interface AuthenticateResult {
  readonly balanceMinor: number;
  readonly config: ClientConfig;
  readonly activeRound: RoundView | null;
  /** Сетка покоя: итоговая сетка последнего закрытого раунда, у нового кошелька — заставка. */
  readonly idleGrid: readonly number[];
  readonly notice: StorageNotice | null;
}

/** Баланс — после списания ставки. */
export interface PlayResult {
  readonly round: RoundView;
  readonly balanceMinor: number;
}

/** endRound — баланс после зачисления, resetBalance — после сброса. */
export interface BalanceResult {
  readonly balanceMinor: number;
}

export interface Results {
  readonly authenticate: AuthenticateResult;
  readonly play: PlayResult;
  readonly endRound: BalanceResult;
  readonly resetBalance: BalanceResult;
}

export type ProtocolError =
  | { readonly code: 'INSUFFICIENT_FUNDS'; readonly balanceMinor: number }
  | { readonly code: 'ROUND_ACTIVE'; readonly roundId: string }
  | { readonly code: 'ROUND_NOT_FOUND'; readonly roundId: string }
  | { readonly code: 'INVALID_BET'; readonly betMinor: number }
  | { readonly code: 'IDEMPOTENCY_CONFLICT' }
  | { readonly code: 'BAD_REQUEST'; readonly message: string }
  | { readonly code: 'VERSION_MISMATCH'; readonly supported: number }
  | { readonly code: 'INTERNAL'; readonly message: string };

export type ErrorCode = ProtocolError['code'];

export type ResponseBody<T = unknown> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: ProtocolError };

/** Сервер: тело запроса. betMinor проверяется как целое — уровень ставки проверяет сервер (INVALID_BET). */
export function checkRequestBody(body: unknown): string | null {
  if (!isRecord(body)) return 'тело запроса — не объект';
  switch (body['type']) {
    case 'authenticate':
    case 'resetBalance':
      return null;
    case 'play':
      if (!isNat(body['betMinor'])) return 'play: betMinor — не целое';
      return isToken(body['idempotencyKey']) ? null : 'play: idempotencyKey — не ключ';
    case 'endRound':
      return isToken(body['roundId']) ? null : 'endRound: roundId — не id раунда';
    default:
      return 'неизвестный тип запроса';
  }
}

/** Раунд ответа: поля, события по гарду и итог раунда, равный end. */
export function checkRoundView(value: unknown): string | null {
  if (!isRecord(value)) return 'раунд — не объект';
  if (!isToken(value['roundId'])) return 'раунд: roundId — не id';
  if (!isPositive(value['betMinor'])) return 'раунд: betMinor — не положительное целое';
  const payX100 = value['payX100'];
  if (!isNat(payX100) || !isNat(value['winMinor'])) return 'раунд: payX100 или winMinor — не целые';
  const events = value['events'];
  const problem = checkRoundEvents(events);
  if (problem !== null) return `раунд: ${problem}`;
  const end = (events as readonly RoundEvent[]).at(-1);
  return end?.t === 'end' && end.payX100 === payX100 ? null : 'раунд: payX100 не равен итогу end';
}

function configProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'config — не объект';
  const levels = value['betLevelsMinor'];
  if (!isAscendingInts(levels, 1, Number.MAX_SAFE_INTEGER) || levels.length === 0) return 'config: ставки не по возрастанию';
  return isPositive(value['capX100']) ? null : 'config: capX100 — не положительное целое';
}

function authenticateProblem(value: Readonly<Record<string, unknown>>): string | null {
  if (!isNat(value['balanceMinor'])) return 'authenticate: balanceMinor — не целое';
  const config = configProblem(value['config']);
  if (config !== null) return `authenticate: ${config}`;
  const active = value['activeRound'];
  if (active !== null) {
    const problem = checkRoundView(active);
    if (problem !== null) return `authenticate: активный ${problem}`;
  }
  if (!isSymbolGrid(value['idleGrid'])) return 'authenticate: idleGrid — не 49 символов';
  const notice = value['notice'];
  return notice === null || notice === 'volatile' || notice === 'reset' ? null : 'authenticate: неизвестное уведомление';
}

/** Клиент: результат под тип запроса, который он отправил. */
export function checkResult(type: RequestType, value: unknown): string | null {
  if (!isRecord(value)) return 'результат — не объект';
  switch (type) {
    case 'authenticate':
      return authenticateProblem(value);
    case 'play': {
      const problem = checkRoundView(value['round']);
      if (problem !== null) return `play: ${problem}`;
      return isNat(value['balanceMinor']) ? null : 'play: balanceMinor — не целое';
    }
    case 'endRound':
    case 'resetBalance':
      return isNat(value['balanceMinor']) ? null : `${type}: balanceMinor — не целое`;
  }
}

export function checkError(value: unknown): string | null {
  if (!isRecord(value)) return 'ошибка — не объект';
  const code: unknown = value['code'];
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return isNat(value['balanceMinor']) ? null : `${code}: balanceMinor — не целое`;
    case 'ROUND_ACTIVE':
    case 'ROUND_NOT_FOUND':
      return isToken(value['roundId']) ? null : `${code}: roundId — не id`;
    case 'INVALID_BET':
      return isNat(value['betMinor']) ? null : `${code}: betMinor — не целое`;
    case 'IDEMPOTENCY_CONFLICT':
      return null;
    case 'BAD_REQUEST':
    case 'INTERNAL':
      return typeof value['message'] === 'string' ? null : `${code}: message — не строка`;
    case 'VERSION_MISMATCH':
      return isPositive(value['supported']) ? null : `${code}: supported — не версия`;
    default:
      return 'неизвестный код ошибки';
  }
}
