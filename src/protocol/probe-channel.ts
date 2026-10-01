import { isIntIn, isRecord } from './guards.ts';

// Канал зонда dev и e2e (фаза 5) — мимо протокола v1: сообщений игры по нему нет, в прод-сборке его не слушает никто
// (греп маркера — tests/e2e/bundle.spec.ts). Зонд задаёт сид следующего раунда: фича и большой выигрыш без сотен спинов.

export const PROBE_CHANNEL = 'cryscade-probe';

export interface ForceRound {
  readonly type: 'forceRound';
  /** Сид раунда — uint32, как у живого источника. */
  readonly seed: number;
}

/** Ответ воркера: сид принят — следующий play возьмёт его. Зонд ждёт ответа, прежде чем нажать «Спін». */
export interface ForceRoundAck {
  readonly type: 'forceRoundAck';
  readonly seed: number;
}

function checkSeedMessage(value: unknown, type: string): string | null {
  if (!isRecord(value)) return 'сообщение — не объект';
  if (value['type'] !== type) return `сообщение — не ${type}`;
  return isIntIn(value['seed'], 0, 0xffff_ffff) ? null : `${type}: сид — не uint32`;
}

/** Воркер: сообщение канала зонда. Мусор — не наше сообщение. Не бросает. */
export function checkForceRound(value: unknown): string | null {
  return checkSeedMessage(value, 'forceRound');
}

/** Зонд: ответ воркера на forceRound. */
export function checkForceRoundAck(value: unknown): string | null {
  return checkSeedMessage(value, 'forceRoundAck');
}

/**
 * Положительный контроль замера памяти (§13, фаза 9): зонд шлёт его на каждый новый раунд под ?memleak=1, воркер держит
 * объект на каждое такое сообщение — проверка кучи воркера обязана покраснеть.
 */
export interface MemoryLeak {
  readonly type: 'memoryLeak';
}

/** Воркер: сообщение канала зонда — memoryLeak. Не бросает. */
export function checkMemoryLeak(value: unknown): string | null {
  if (!isRecord(value)) return 'сообщение — не объект';
  return value['type'] === 'memoryLeak' ? null : 'сообщение — не memoryLeak';
}
