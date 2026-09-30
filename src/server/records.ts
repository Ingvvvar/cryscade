import type { RoundEvent } from '../core/model/events.ts';
import { BOOK_RECORDS_MAX, checkRoundEvents, isClientSeed, isHex64, isIntIn, isNat, isRecord, isToken, type RoundOrigin } from '../protocol/index.ts';
import type { StoreName } from './ports.ts';
import { FAIRNESS_ID, WALLET_ID } from './schema.ts';

// Записи IndexedDB (§6.6) и их гарды. Всё, что прочитано из хранилища, проходит гард: испорченное не роняет
// сервер, а уходит по пути починки. v2 (фаза 6): у раунда — происхождение и поля честности; раунд v1 без них — живой.

export interface WalletRecord {
  readonly id: typeof WALLET_ID;
  readonly balanceMinor: number;
  readonly activeRoundId: string | null;
  /** seq следующего раунда: больше seq любого раунда в хранилище. */
  readonly nextSeq: number;
  /** Растёт с каждой записью — условие CAS и порядок оповещений. */
  readonly revision: number;
  /** nextSeq на момент последнего сброса баланса: раунды с seq ≥ resetSeq сыграны после него. */
  readonly resetSeq: number;
}

export type RoundStatus = 'active' | 'closed';

export interface RoundRecord {
  readonly roundId: string;
  readonly seq: number;
  readonly idempotencyKey: string;
  readonly betMinor: number;
  readonly seed: number;
  readonly payX100: number;
  readonly winMinor: number;
  readonly events: readonly RoundEvent[];
  readonly createdAt: number;
  readonly status: RoundStatus;
  readonly balanceAfterBet: number;
  /** null, пока раунд активен. */
  readonly balanceAfterEnd: number | null;
  /**
   * Фаза 6. Происхождение: book — выбран по HMAC (секрет с обязательством commitment, сид игрока clientSeed, nonce) из
   * записи bookIndex; forced и live — без честности, поля — null. У раунда v1 полей нет — он live.
   */
  readonly source?: RoundOrigin;
  readonly bookIndex?: number | null;
  readonly nonce?: number | null;
  readonly commitment?: string | null;
  readonly clientSeed?: string | null;
}

/** Честность раунда, как её видят ответы и история: у записи v1 — live и null. */
export interface RoundFairness {
  readonly source: RoundOrigin;
  readonly bookIndex: number | null;
  readonly nonce: number | null;
  readonly commitment: string | null;
  readonly clientSeed: string | null;
}

export function fairnessOf(round: RoundRecord): RoundFairness {
  return {
    source: round.source ?? 'live',
    bookIndex: round.bookIndex ?? null,
    nonce: round.nonce ?? null,
    commitment: round.commitment ?? null,
    clientSeed: round.clientSeed ?? null,
  };
}

/** Состояние честности (§7): обязательство текущего секрета, сид игрока и nonce следующего раунда книги. */
export interface FairnessRecord {
  readonly id: typeof FAIRNESS_ID;
  readonly commitment: string;
  readonly clientSeed: string;
  readonly nonce: number;
}

/** Секрет сервера: 32 байта hex; обязательство — его SHA-256. revealedAt — когда раскрыт, null — текущий. */
export interface SecretRecord {
  readonly commitment: string;
  readonly secret: string;
  readonly createdAt: number;
  readonly revealedAt: number | null;
}

/** Раунд без событий. Цел — значит события можно пересчитать движком по сиду. */
export type RoundCore = Omit<RoundRecord, 'events'>;

export interface KeyRecord {
  readonly key: string;
  readonly roundId: string;
  readonly betMinor: number;
}

export interface QuarantineRecord {
  readonly store: StoreName;
  readonly raw: unknown;
  readonly reason: string;
  readonly at: number;
}

const U32_MAX = 0xffff_ffff;

/**
 * Верхняя граница счётчиков и денег в записях — 2^52. Запас до 2^53: +1 к seq и revision и зачисление выигрыша
 * остаются точными целыми, и сервер не запишет того, что сам отвергнет при чтении. Честной игрой её не достичь;
 * больше — запись испорчена.
 */
export const RECORD_LIMIT = 4_503_599_627_370_496;

/**
 * Граница, до которой починка продолжает счёт seq и revision, — 2^51. Выше — счёт с начала: после починки до границы
 * записей остаётся не меньше 2^51, и следующий спин снова не упрётся в неё. Продолжай починка счёт у самой границы,
 * через раунд кошелёк снова остался бы без запаса — и так по кругу.
 */
export const RESUME_LIMIT = 2_251_799_813_685_248;

/** Деньги и счётчики с нуля: безопасное целое от 0 до RECORD_LIMIT. */
const isAmount = (value: unknown): value is number => isIntIn(value, 0, RECORD_LIMIT);
/** Номера и ставки: безопасное целое от 1 до RECORD_LIMIT. */
const isOrdinal = (value: unknown): value is number => isIntIn(value, 1, RECORD_LIMIT);

/** seq в границах записей: такой seq может занять следующий раунд — с ним сверяется nextSeq кошелька. */
export const isSeq = isOrdinal;

/** Годный seq: безопасное целое от 1 до RESUME_LIMIT — с него починка продолжает счёт. */
export const isResumableSeq = (value: unknown): value is number => isIntIn(value, 1, RESUME_LIMIT);

export function checkWallet(value: unknown): string | null {
  if (!isRecord(value)) return 'кошелёк — не объект';
  if (value['id'] !== WALLET_ID) return 'кошелёк: чужой id';
  if (!isAmount(value['balanceMinor'])) return 'кошелёк: balanceMinor — не целое до 2^52';
  const active = value['activeRoundId'];
  if (active !== null && !isToken(active)) return 'кошелёк: activeRoundId — не id';
  const nextSeq = value['nextSeq'];
  const resetSeq = value['resetSeq'];
  if (!isOrdinal(nextSeq) || !isOrdinal(resetSeq) || resetSeq > nextSeq) return 'кошелёк: nextSeq или resetSeq не по порядку';
  return isAmount(value['revision']) ? null : 'кошелёк: revision — не целое до 2^52';
}

export function isWallet(value: unknown): value is WalletRecord {
  return checkWallet(value) === null;
}

export function checkRoundCore(value: unknown): string | null {
  if (!isRecord(value)) return 'раунд — не объект';
  if (!isToken(value['roundId']) || !isToken(value['idempotencyKey'])) return 'раунд: roundId или ключ — не id';
  if (!isOrdinal(value['seq']) || !isOrdinal(value['betMinor'])) return 'раунд: seq или betMinor — не положительные целые до 2^52';
  if (!isIntIn(value['seed'], 0, U32_MAX)) return 'раунд: сид — не u32';
  const winMinor = value['winMinor'];
  if (!isAmount(value['payX100']) || !isAmount(winMinor)) return 'раунд: payX100 или winMinor — не целые до 2^52';
  if (!isNat(value['createdAt'])) return 'раунд: createdAt — не целое';
  const afterBet = value['balanceAfterBet'];
  const afterEnd = value['balanceAfterEnd'];
  if (!isAmount(afterBet)) return 'раунд: balanceAfterBet — не целое до 2^52';
  switch (value['status']) {
    case 'active':
      if (afterEnd !== null) return 'раунд: у активного есть balanceAfterEnd';
      break;
    case 'closed':
      if (!isAmount(afterEnd) || afterEnd !== afterBet + winMinor) return 'раунд: balanceAfterEnd ≠ balanceAfterBet + winMinor';
      break;
    default:
      return 'раунд: статус — не active и не closed';
  }
  return roundFairnessProblem(value);
}

/** Поля честности раунда v2; у раунда v1 их нет — он живой. У книги — все по формату, у остальных — null. */
function roundFairnessProblem(value: Readonly<Record<string, unknown>>): string | null {
  const source = value['source'];
  const fields = ['bookIndex', 'nonce', 'commitment', 'clientSeed'] as const;
  if (source === undefined) return fields.some((name) => name in value) ? 'раунд: поля честности без source' : null;
  if (source === 'book') {
    if (!isIntIn(value['bookIndex'], 0, BOOK_RECORDS_MAX - 1)) return 'раунд: bookIndex — не индекс книги';
    if (!isAmount(value['nonce'])) return 'раунд: nonce — не целое до 2^52';
    return isHex64(value['commitment']) && isClientSeed(value['clientSeed']) ? null : 'раунд: обязательство или сид игрока не по формату';
  }
  if (source !== 'forced' && source !== 'live') return 'раунд: source — не book, forced или live';
  return fields.every((name) => value[name] === null) ? null : 'раунд: у раунда не из книги есть поля честности';
}

export function checkRound(value: unknown): string | null {
  const core = checkRoundCore(value);
  if (core !== null) return core;
  const { events, payX100 } = value as RoundRecord;
  const problem = checkRoundEvents(events);
  if (problem !== null) return `раунд: ${problem}`;
  const end = events.at(-1);
  return end?.t === 'end' && end.payX100 === payX100 ? null : 'раунд: payX100 не равен итогу end';
}

export function checkKey(value: unknown): string | null {
  if (!isRecord(value)) return 'ключ — не объект';
  if (!isToken(value['key']) || !isToken(value['roundId'])) return 'ключ: key или roundId — не id';
  return isOrdinal(value['betMinor']) ? null : 'ключ: betMinor — не положительное целое до 2^52';
}

export function checkFairness(value: unknown): string | null {
  if (!isRecord(value)) return 'честность — не объект';
  if (value['id'] !== FAIRNESS_ID) return 'честность: чужой id';
  if (!isHex64(value['commitment'])) return 'честность: обязательство — не 64 знака hex';
  if (!isClientSeed(value['clientSeed'])) return 'честность: сид игрока не по формату';
  return isAmount(value['nonce']) ? null : 'честность: nonce — не целое до 2^52';
}

export function checkSecret(value: unknown): string | null {
  if (!isRecord(value)) return 'секрет — не объект';
  if (!isHex64(value['commitment']) || !isHex64(value['secret'])) return 'секрет: обязательство или секрет — не 64 знака hex';
  if (!isNat(value['createdAt'])) return 'секрет: createdAt — не целое';
  const revealedAt = value['revealedAt'];
  return revealedAt === null || isNat(revealedAt) ? null : 'секрет: revealedAt — не целое и не null';
}
