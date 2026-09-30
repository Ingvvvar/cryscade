// Честность (§7): выбор записи книги по HMAC — чистые функции без криптографии. HMAC-SHA256(ключ = секрет сервера,
// сообщение = `${clientSeed}:${nonce}:${counter}`), первые 8 байт — uint64 big-endian; значения не меньше
// floor(2^64 / W) · W отбрасываются (counter + 1), иначе остаток от деления на W — точка на накопленных весах книги.
// Их зовут и сервер, и инструмент проверки: HMAC приходит функцией — WebCrypto в воркере, node:crypto в Node.

import type { Book } from './book.ts';

const TWO_64 = 1n << 64n;
/** Отбрасывание с вероятностью W / 2^64 на шаг: 64 подряд — не случай, а поломка источника байтов. */
export const MAX_COUNTER = 64;

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** hex → байты; строка обязана быть чётной длины из [0-9a-f]. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new RangeError('не hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(2 * index, 2 * index + 2), 16);
  return bytes;
}

/** Сообщение HMAC — ASCII: сид игрока из [0-9A-Za-z], nonce и counter — десятичные целые. */
export function fairnessMessage(clientSeed: string, nonce: number, counter: number): Uint8Array {
  return new TextEncoder().encode(`${clientSeed}:${String(nonce)}:${String(counter)}`);
}

/** Первые 8 байт дайджеста — uint64 big-endian; за границей равномерности — null (следующий counter), иначе value mod W. */
export function pickValue(digest: Uint8Array, total: number): number | null {
  if (!Number.isSafeInteger(total) || total < 1) throw new RangeError(`сумма весов ${String(total)}`);
  if (digest.length < 8) throw new RangeError('дайджест короче 8 байт');
  let value = 0n;
  for (let index = 0; index < 8; index++) value = (value << 8n) | BigInt(digest[index] ?? 0);
  const weight = BigInt(total);
  const limit = (TWO_64 / weight) * weight;
  return value >= limit ? null : Number(value % weight);
}

export interface Draw {
  readonly index: number;
  /** На каком counter значение прошло: 0 — сразу. */
  readonly counter: number;
}

/** Индекс книги для (секрет, сид игрока, nonce): counter 0, 1, … до первого не отброшенного значения. */
export async function drawIndex(
  hmac: (key: Uint8Array, message: Uint8Array) => Promise<Uint8Array>,
  secret: Uint8Array,
  clientSeed: string,
  nonce: number,
  book: Book,
): Promise<Draw> {
  for (let counter = 0; counter < MAX_COUNTER; counter++) {
    const value = pickValue(await hmac(secret, fairnessMessage(clientSeed, nonce, counter)), book.total);
    if (value !== null) return { index: book.indexOf(value), counter };
  }
  throw new Error(`выбор из книги: ${String(MAX_COUNTER)} значений подряд за границей равномерности`);
}
