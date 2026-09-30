// Книга исходов (§5): формат и чтение. Одним модулем пользуются генератор (tools/books) и воркер. Запись книги —
// сид, итог и вес; события раунда восстанавливает движок из сида. Двоичный формат, little-endian:
//   заголовок 18 байт — магия 'CRYB', версия u16, число записей u32, сумма весов u64;
//   записи по 12 байт — seed u32, payX100 u32, weight u32.
// Всё прочитанное проходит гард: битая книга — ошибка с причиной, а не игра на битых данных.

import { BOOK_RECORDS_MAX } from '../protocol/index.ts';

const MAGIC = [0x43, 0x52, 0x59, 0x42] as const;
export const BOOK_VERSION = 1;
const HEADER = 18;
const RECORD = 12;
/** Не больше 80 000 записей (§5): книга с запасом ложится в 1 МБ gzip. Индекс книги в протоколе — тот же предел. */
export const BOOK_MAX_RECORDS = BOOK_RECORDS_MAX;

export interface BookRecord {
  readonly seed: number;
  readonly payX100: number;
  readonly weight: number;
}

const U32_MAX = 0xffff_ffff;
const isU32 = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= U32_MAX;

/** Записи → байты книги. Сумма весов — точное целое до 2^53: иначе накопленные веса не выбрать без BigInt. */
export function encodeBook(records: readonly BookRecord[]): Uint8Array {
  if (records.length < 1 || records.length > BOOK_MAX_RECORDS) throw new RangeError(`записей ${String(records.length)}, можно 1…${String(BOOK_MAX_RECORDS)}`);
  const bytes = new Uint8Array(HEADER + RECORD * records.length);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint16(4, BOOK_VERSION, true);
  view.setUint32(6, records.length, true);
  let total = 0;
  records.forEach((record, index) => {
    const { seed, payX100, weight } = record;
    if (!isU32(seed) || !isU32(payX100) || !isU32(weight) || weight < 1) throw new RangeError(`запись ${String(index)}: сид, итог и вес — u32, вес от 1`);
    total += weight;
    const at = HEADER + RECORD * index;
    view.setUint32(at, seed, true);
    view.setUint32(at + 4, payX100, true);
    view.setUint32(at + 8, weight, true);
  });
  if (!Number.isSafeInteger(total)) throw new RangeError('сумма весов вне точных целых');
  view.setBigUint64(10, BigInt(total), true);
  return bytes;
}

/** Книга в памяти: записи в типизированных массивах и накопленные веса для выбора по значению. */
export class Book {
  readonly size: number;
  /** Сумма весов — W выбора (§7); точное целое до 2^53. */
  readonly total: number;
  readonly #seeds: Uint32Array;
  readonly #pays: Uint32Array;
  readonly #weights: Uint32Array;
  /** cumulative[i] — сумма весов записей 0…i. */
  readonly #cumulative: Float64Array;

  constructor(seeds: Uint32Array, pays: Uint32Array, weights: Uint32Array) {
    this.size = seeds.length;
    this.#seeds = seeds;
    this.#pays = pays;
    this.#weights = weights;
    this.#cumulative = new Float64Array(this.size);
    let running = 0;
    for (let index = 0; index < this.size; index++) {
      running += weights[index] ?? 0;
      this.#cumulative[index] = running;
    }
    this.total = running;
  }

  record(index: number): BookRecord {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) throw new RangeError(`индекс книги ${String(index)} вне 0…${String(this.size - 1)}`);
    return { seed: this.#seeds[index] ?? 0, payX100: this.#pays[index] ?? 0, weight: this.#weights[index] ?? 0 };
  }

  /** Запись, в чей отрезок накопленных весов попало значение 0 ≤ value < total: первая, у которой накопленный вес больше. */
  indexOf(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value >= this.total) throw new RangeError(`значение ${String(value)} вне 0…${String(this.total - 1)}`);
    let low = 0;
    let high = this.size - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.#cumulative[middle] ?? 0) > value) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}

export type BookRead = { readonly ok: true; readonly book: Book } | { readonly ok: false; readonly problem: string };

/** Байты → книга через гард: магия, версия, размер, веса от 1, сумма в заголовке равна сумме записей, итог не выше капа. */
export function decodeBook(bytes: Uint8Array, capX100: number): BookRead {
  const fail = (problem: string): BookRead => ({ ok: false, problem: `книга: ${problem}` });
  if (bytes.length < HEADER) return fail('короче заголовка');
  if (MAGIC.some((byte, index) => bytes[index] !== byte)) return fail('не та магия');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== BOOK_VERSION) return fail(`версия ${String(version)}, ожидалась ${String(BOOK_VERSION)}`);
  const count = view.getUint32(6, true);
  if (count < 1 || count > BOOK_MAX_RECORDS) return fail(`записей ${String(count)}`);
  if (bytes.length !== HEADER + RECORD * count) return fail(`длина ${String(bytes.length)} не сходится с числом записей`);
  const declared = view.getBigUint64(10, true);
  if (declared > BigInt(Number.MAX_SAFE_INTEGER)) return fail('сумма весов вне точных целых');
  const seeds = new Uint32Array(count);
  const pays = new Uint32Array(count);
  const weights = new Uint32Array(count);
  let total = 0;
  for (let index = 0; index < count; index++) {
    const at = HEADER + RECORD * index;
    const payX100 = view.getUint32(at + 4, true);
    const weight = view.getUint32(at + 8, true);
    if (weight < 1) return fail(`запись ${String(index)}: вес 0`);
    if (payX100 > capX100) return fail(`запись ${String(index)}: итог выше капа`);
    seeds[index] = view.getUint32(at, true);
    pays[index] = payX100;
    weights[index] = weight;
    total += weight;
  }
  if (BigInt(total) !== declared) return fail('сумма весов в заголовке не равна сумме записей');
  return { ok: true, book: new Book(seeds, pays, weights) };
}
