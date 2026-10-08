import type { RoundEvent } from '../core/model/events.ts';
import { isAscendingInts, isClientSeed, isHex64, isIntIn, isNat, isPositive, isRecord, isToken } from './guards.ts';
import { checkRoundEvents, isSymbolGrid } from './round-events.ts';

// Сообщения протокола v1 (§6.1): тела запросов, результаты, ошибки. Только простые данные — переживают postMessage
// и JSON. Новые сообщения и поля добавляются внутри v1; гарды проверяют известные поля и не мешают лишним.

export type RequestBody =
  | { readonly type: 'authenticate' }
  | { readonly type: 'play'; readonly betMinor: number; readonly idempotencyKey: string }
  | { readonly type: 'endRound'; readonly roundId: string }
  | { readonly type: 'resetBalance' }
  /** Фаза 6 (§6.1, §7): сид игрока — меняет и секрет сервера, раскрывая прежний; nonce с нуля. */
  | { readonly type: 'setClientSeed'; readonly clientSeed: string }
  /** Смена секрета: прежний раскрыт, новое обязательство, nonce с нуля. */
  | { readonly type: 'rotateSeed' }
  /** Последние раунды, новые первыми, не больше limit (1…100). */
  | { readonly type: 'history'; readonly limit: number }
  /** События раунда из своей истории или записи книги — без движения денег. */
  | { readonly type: 'replay'; readonly round: string }
  | { readonly type: 'replay'; readonly book: number }
  /** Загрузить книгу исходов заранее — страница просит после первого кадра, чтобы первый спин её не ждал. */
  | { readonly type: 'loadBook' }
  /**
   * Фаза 7 (§7, панель «Перевірити»): пересчёт выбора по раскрытому секрету — обязательство (SHA-256 секрета) и запись
   * книги, на которую указывает HMAC. Ничего не пишет. Независимая проверка — docs/fairness.md и tools/fairness.
   */
  | { readonly type: 'verify'; readonly secret: string; readonly clientSeed: string; readonly nonce: number };

export type RequestType = RequestBody['type'];

/** Записей в книге — не больше (§5): индекс книги — от 0 до BOOK_RECORDS_MAX − 1. */
export const BOOK_RECORDS_MAX = 80_000;

/**
 * Откуда раунд: book — выбран из книги по HMAC (§7), forced — принудительный dev и e2e, в проверке честности не
 * участвует; live — живой ГСЧ до фазы 6 («до честности»).
 */
export type RoundOrigin = 'book' | 'forced' | 'live';

/** Раунд в ответе — всё, что нужно показу, и откуда он: у раунда книги — индекс записи и nonce. */
export interface RoundView {
  readonly roundId: string;
  readonly betMinor: number;
  readonly payX100: number;
  readonly winMinor: number;
  readonly events: readonly RoundEvent[];
  readonly source: RoundOrigin;
  readonly bookIndex: number | null;
  readonly nonce: number | null;
}

/** Честность сейчас (§7): обязательство — SHA-256 секрета в hex, сид игрока, nonce следующего раунда. */
export interface FairnessView {
  readonly commitment: string;
  readonly clientSeed: string;
  readonly nonce: number;
}

/** Что клиенту знать об игре. С фазы 7 — пресет и таблица выплат. */
export interface ClientConfig {
  readonly betLevelsMinor: readonly number[];
  readonly capX100: number;
}

/** volatile — IndexedDB недоступна, игра идёт в памяти; reset — данные были испорчены, баланс восстановлен до 1000. */
export type StorageNotice = 'volatile' | 'reset';

/**
 * Кошелёк в момент ответа (§6.3). По revision клиент упорядочивает ответы вместе с оповещениями walletChanged.
 * notice 'reset' — в этом запросе хранилище чинилось, и revision могла начаться заново: такое принимается без сравнения.
 */
export interface WalletView {
  readonly balanceMinor: number;
  readonly revision: number;
  readonly notice: 'reset' | null;
}

export interface AuthenticateResult {
  readonly balanceMinor: number;
  readonly config: ClientConfig;
  readonly activeRound: RoundView | null;
  /** Сетка покоя: итоговая сетка последнего закрытого раунда, у нового кошелька — заставка. */
  readonly idleGrid: readonly number[];
  readonly notice: StorageNotice | null;
  readonly wallet: WalletView;
  /** Обязательство до игры (§7); null — источник раундов без честности (живой ГСЧ, только тесты). */
  readonly fairness: FairnessView | null;
}

/** balanceMinor — после списания ставки этого раунда; wallet — кошелёк сейчас. У повтора закрытого раунда они расходятся. */
export interface PlayResult {
  readonly round: RoundView;
  readonly balanceMinor: number;
  readonly wallet: WalletView;
}

/** endRound — баланс после зачисления, resetBalance — после сброса; wallet — кошелёк сейчас, как у play. */
export interface BalanceResult {
  readonly balanceMinor: number;
  readonly wallet: WalletView;
}

/** Новое состояние честности и раскрытый прежний секрет: по нему проверяются раунды с прежним обязательством. */
export interface SeedResult {
  readonly fairness: FairnessView;
  readonly revealed: { readonly commitment: string; readonly secret: string };
}

/** Раунд истории: деньги, происхождение и всё для проверки честности; секрет — когда раскрыт. */
export interface HistoryEntry {
  readonly roundId: string;
  readonly createdAt: number;
  readonly betMinor: number;
  readonly payX100: number;
  readonly winMinor: number;
  readonly status: 'active' | 'closed';
  readonly source: RoundOrigin;
  readonly bookIndex: number | null;
  readonly nonce: number | null;
  readonly commitment: string | null;
  readonly clientSeed: string | null;
  readonly secret: string | null;
}

export interface HistoryResult {
  readonly rounds: readonly HistoryEntry[];
}

/**
 * Повтор: события и итог. Раунд истории — со своей ставкой и выигрышем; запись книги ставки не знает — повтор идёт на
 * ставке 1.00 (100 минимальных единиц), выигрыш = payX100.
 */
export interface ReplayResult {
  readonly roundId: string | null;
  readonly bookIndex: number | null;
  readonly betMinor: number;
  readonly payX100: number;
  readonly winMinor: number;
  readonly events: readonly RoundEvent[];
}

export interface LoadBookResult {
  readonly records: number;
}

/** Пересчёт выбора: обязательство секрета, индекс книги, на каком counter значение прошло, и выплата записи. */
export interface VerifyResult {
  readonly commitment: string;
  readonly bookIndex: number;
  readonly counter: number;
  readonly payX100: number;
}

/** counter выбора — от 0 до 63: дальше сервер бросает (server/fairness.ts, MAX_COUNTER). */
const VERIFY_COUNTER_MAX = 63;

export interface Results {
  readonly authenticate: AuthenticateResult;
  readonly play: PlayResult;
  readonly endRound: BalanceResult;
  readonly resetBalance: BalanceResult;
  readonly setClientSeed: SeedResult;
  readonly rotateSeed: SeedResult;
  readonly history: HistoryResult;
  readonly replay: ReplayResult;
  readonly loadBook: LoadBookResult;
  readonly verify: VerifyResult;
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
    case 'rotateSeed':
    case 'loadBook':
      return null;
    case 'play':
      if (!isNat(body['betMinor'])) return 'play: betMinor — не целое';
      return isToken(body['idempotencyKey']) ? null : 'play: idempotencyKey — не ключ';
    case 'endRound':
      return isToken(body['roundId']) ? null : 'endRound: roundId — не id раунда';
    case 'setClientSeed':
      return isClientSeed(body['clientSeed']) ? null : 'setClientSeed: сид игрока — 1…64 знака [0-9A-Za-z]';
    case 'history':
      return isIntIn(body['limit'], 1, 100) ? null : 'history: limit — целое 1…100';
    case 'replay':
      return replayTargetProblem(body);
    case 'verify':
      if (!isHex64(body['secret'])) return 'verify: секрет — 64 знака hex';
      if (!isClientSeed(body['clientSeed'])) return 'verify: сид игрока — 1…64 знака [0-9A-Za-z]';
      return isNat(body['nonce']) ? null : 'verify: nonce — не целое';
    default:
      return 'неизвестный тип запроса';
  }
}

function replayTargetProblem(body: Readonly<Record<string, unknown>>): string | null {
  const hasRound = 'round' in body;
  const hasBook = 'book' in body;
  if (hasRound === hasBook) return 'replay: нужен ровно один из round и book';
  if (hasRound) return isToken(body['round']) ? null : 'replay: round — не id раунда';
  return isIntIn(body['book'], 0, BOOK_RECORDS_MAX - 1) ? null : 'replay: book — не индекс книги';
}

/** Происхождение раунда и его поля честности: у книги — индекс и nonce, у остальных — null. */
function originProblem(value: Readonly<Record<string, unknown>>, withCommitment: boolean): string | null {
  const source = value['source'];
  const bookIndex = value['bookIndex'];
  const nonce = value['nonce'];
  if (source === 'book') {
    if (!isIntIn(bookIndex, 0, BOOK_RECORDS_MAX - 1)) return 'bookIndex — не индекс книги';
    if (!isNat(nonce)) return 'nonce — не целое';
    if (withCommitment && (!isHex64(value['commitment']) || !isClientSeed(value['clientSeed']))) return 'обязательство или сид игрока не по формату';
    return null;
  }
  if (source !== 'forced' && source !== 'live') return 'source — не book, forced или live';
  if (bookIndex !== null || nonce !== null) return 'у раунда не из книги есть bookIndex или nonce';
  if (withCommitment && (value['commitment'] !== null || value['clientSeed'] !== null)) return 'у раунда не из книги есть обязательство';
  return null;
}

function fairnessProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'fairness — не объект';
  if (!isHex64(value['commitment'])) return 'fairness: обязательство — не 64 знака hex';
  if (!isClientSeed(value['clientSeed'])) return 'fairness: сид игрока не по формату';
  return isNat(value['nonce']) ? null : 'fairness: nonce — не целое';
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
  if (end?.t !== 'end' || end.payX100 !== payX100) return 'раунд: payX100 не равен итогу end';
  const origin = originProblem(value, false);
  return origin === null ? null : `раунд: ${origin}`;
}

function configProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'config — не объект';
  const levels = value['betLevelsMinor'];
  if (!isAscendingInts(levels, 1, Number.MAX_SAFE_INTEGER) || levels.length === 0) return 'config: ставки не по возрастанию';
  return isPositive(value['capX100']) ? null : 'config: capX100 — не положительное целое';
}

function walletProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'wallet — не объект';
  if (!isNat(value['balanceMinor']) || !isNat(value['revision'])) return 'wallet: balanceMinor или revision — не целые';
  const notice = value['notice'];
  return notice === null || notice === 'reset' ? null : 'wallet: неизвестное уведомление';
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
  if (notice !== null && notice !== 'volatile' && notice !== 'reset') return 'authenticate: неизвестное уведомление';
  const wallet = walletProblem(value['wallet']);
  if (wallet !== null) return `authenticate: ${wallet}`;
  const fairness = value['fairness'];
  if (fairness === null) return null;
  const problem = fairnessProblem(fairness);
  return problem === null ? null : `authenticate: ${problem}`;
}

function seedProblem(type: RequestType, value: Readonly<Record<string, unknown>>): string | null {
  const fairness = fairnessProblem(value['fairness']);
  if (fairness !== null) return `${type}: ${fairness}`;
  const revealed = value['revealed'];
  if (!isRecord(revealed) || !isHex64(revealed['commitment']) || !isHex64(revealed['secret'])) return `${type}: раскрытый секрет не по формату`;
  return null;
}

function historyEntryProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'раунд — не объект';
  if (!isToken(value['roundId'])) return 'roundId — не id';
  if (!isNat(value['createdAt']) || !isPositive(value['betMinor']) || !isNat(value['payX100']) || !isNat(value['winMinor'])) return 'время, ставка или выигрыш — не целые';
  const status = value['status'];
  if (status !== 'active' && status !== 'closed') return 'статус — не active и не closed';
  const origin = originProblem(value, true);
  if (origin !== null) return origin;
  const secret = value['secret'];
  return secret === null || isHex64(secret) ? null : 'секрет — не 64 знака hex';
}

function historyProblem(value: Readonly<Record<string, unknown>>): string | null {
  const rounds = value['rounds'];
  if (!Array.isArray(rounds) || rounds.length > 100) return 'history: rounds — не список до 100';
  const items: readonly unknown[] = rounds;
  for (const [index, item] of items.entries()) {
    const problem = historyEntryProblem(item);
    if (problem !== null) return `history: раунд ${String(index)}: ${problem}`;
  }
  return null;
}

function replayProblem(value: Readonly<Record<string, unknown>>): string | null {
  const roundId = value['roundId'];
  const bookIndex = value['bookIndex'];
  const fromRound = isToken(roundId) && bookIndex === null;
  const fromBook = roundId === null && isIntIn(bookIndex, 0, BOOK_RECORDS_MAX - 1);
  if (!fromRound && !fromBook) return 'replay: нужен ровно один из roundId и bookIndex';
  if (!isPositive(value['betMinor'])) return 'replay: betMinor — не положительное целое';
  const payX100 = value['payX100'];
  if (!isNat(payX100) || !isNat(value['winMinor'])) return 'replay: payX100 или winMinor — не целые';
  const events = value['events'];
  const problem = checkRoundEvents(events);
  if (problem !== null) return `replay: ${problem}`;
  const end = (events as readonly RoundEvent[]).at(-1);
  return end?.t === 'end' && end.payX100 === payX100 ? null : 'replay: payX100 не равен итогу end';
}

/** Баланс результата и кошелёк в момент ответа. */
function balanceProblem(type: RequestType, value: Readonly<Record<string, unknown>>): string | null {
  if (!isNat(value['balanceMinor'])) return `${type}: balanceMinor — не целое`;
  const wallet = walletProblem(value['wallet']);
  return wallet === null ? null : `${type}: ${wallet}`;
}

/** Клиент: результат под тип запроса, который он отправил. */
export function checkResult(type: RequestType, value: unknown): string | null {
  if (!isRecord(value)) return 'результат — не объект';
  switch (type) {
    case 'authenticate':
      return authenticateProblem(value);
    case 'play': {
      const problem = checkRoundView(value['round']);
      return problem === null ? balanceProblem(type, value) : `play: ${problem}`;
    }
    case 'endRound':
    case 'resetBalance':
      return balanceProblem(type, value);
    case 'setClientSeed':
    case 'rotateSeed':
      return seedProblem(type, value);
    case 'history':
      return historyProblem(value);
    case 'replay':
      return replayProblem(value);
    case 'loadBook':
      return isIntIn(value['records'], 1, BOOK_RECORDS_MAX) ? null : 'loadBook: records — не число записей книги';
    case 'verify':
      if (!isHex64(value['commitment'])) return 'verify: обязательство — не 64 знака hex';
      if (!isIntIn(value['bookIndex'], 0, BOOK_RECORDS_MAX - 1)) return 'verify: bookIndex — не индекс книги';
      if (!isIntIn(value['counter'], 0, VERIFY_COUNTER_MAX)) return 'verify: counter — не 0…63';
      return isNat(value['payX100']) ? null : 'verify: payX100 — не целое';
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
