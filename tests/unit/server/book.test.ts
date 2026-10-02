import { describe, expect, it } from 'vitest';
import { BOOK_MAX_RECORDS, decodeBook, encodeBook } from '../../../src/server/book.ts';

// Формат книги §5 литералами: заголовок 'CRYB', версия u16, записей u32, сумма весов u64, записи seed/payX100/weight
// u32 — всё little-endian. Байты выписаны руками.

const TWO = [
  { seed: 1, payX100: 0, weight: 3 },
  { seed: 48, payX100: 3350, weight: 1 },
];
const TWO_BYTES = Uint8Array.from([
  0x43, 0x52, 0x59, 0x42, // 'CRYB'
  0x01, 0x00, // версия 1
  0x02, 0x00, 0x00, 0x00, // 2 записи
  0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // сумма весов 4
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, // сид 1, итог 0, вес 3
  0x30, 0x00, 0x00, 0x00, 0x16, 0x0d, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // сид 48, итог 3350 = 0x0d16, вес 1
]);
const CAP = 500_000;

/** Текст RangeError действия: по нему видно, какая проверка сработала. Не бросило или не RangeError — другая строка. */
function rangeError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof RangeError ? error.message : `не RangeError: ${String(error)}`;
  }
  return 'не бросило';
}

function edited(edit: (bytes: Uint8Array, view: DataView) => void): Uint8Array {
  const bytes = Uint8Array.from(TWO_BYTES);
  edit(bytes, new DataView(bytes.buffer));
  return bytes;
}

/** Копия двух записей с одним полем, записанным little-endian. */
const u16 = (offset: number, value: number): Uint8Array =>
  edited((_, view) => {
    view.setUint16(offset, value, true);
  });
const u32 = (offset: number, value: number): Uint8Array =>
  edited((_, view) => {
    view.setUint32(offset, value, true);
  });
const u64 = (offset: number, value: bigint): Uint8Array =>
  edited((_, view) => {
    view.setBigUint64(offset, value, true);
  });

describe('книга: формат', () => {
  it('две записи — побайтно', () => {
    expect(encodeBook(TWO)).toStrictEqual(TWO_BYTES);
  });

  it('чтение: записи, сумма весов, индекс по значению — 0…2 первая запись, 3 — вторая', () => {
    const read = decodeBook(TWO_BYTES, CAP);
    if (!read.ok) throw new Error(read.problem);
    const { book } = read;
    expect([book.size, book.total]).toStrictEqual([2, 4]);
    expect([book.record(0), book.record(1)]).toStrictEqual(TWO);
    expect([0, 1, 2, 3].map((value) => book.indexOf(value))).toStrictEqual([0, 0, 0, 1]);
  });

  it('индекс по значению на границах отрезков: веса 1, 2, 3 — значения 0 | 1 2 | 3 4 5', () => {
    const read = decodeBook(
      encodeBook([
        { seed: 7, payX100: 0, weight: 1 },
        { seed: 8, payX100: 95, weight: 2 },
        { seed: 9, payX100: 190, weight: 3 },
      ]),
      CAP,
    );
    if (!read.ok) throw new Error(read.problem);
    expect([0, 1, 2, 3, 4, 5].map((value) => read.book.indexOf(value))).toStrictEqual([0, 1, 1, 2, 2, 2]);
    expect([6, -1, 0.5].map((value) => rangeError(() => read.book.indexOf(value)))).toStrictEqual([
      'значение 6 вне 0…5',
      'значение -1 вне 0…5',
      'значение 0.5 вне 0…5',
    ]);
    expect([3, -1, 1.5].map((index) => rangeError(() => read.book.record(index)))).toStrictEqual([
      'индекс книги 3 вне 0…2',
      'индекс книги -1 вне 0…2',
      'индекс книги 1.5 вне 0…2',
    ]);
  });

  it.each([
    ['короче заголовка', TWO_BYTES.slice(0, 17), 'книга: короче заголовка'],
    ['ровно заголовок', TWO_BYTES.slice(0, 18), 'книга: длина 18 не сходится с числом записей'],
    ['не та магия', edited((bytes) => (bytes[3] = 0x41)), 'книга: не та магия'],
    ['версия 2', u16(4, 2), 'книга: версия 2, ожидалась 1'],
    ['записей 0', u32(6, 0), 'книга: записей 0'],
    ['записей больше предела', u32(6, BOOK_MAX_RECORDS + 1), `книга: записей ${String(BOOK_MAX_RECORDS + 1)}`],
    ['записей больше, чем байт', u32(6, 3), 'книга: длина 42 не сходится с числом записей'],
    ['лишний байт', Uint8Array.from([...TWO_BYTES, 0]), 'книга: длина 43 не сходится с числом записей'],
    ['сумма весов вне точных целых', u64(10, 2n ** 53n), 'книга: сумма весов вне точных целых'],
    ['сумма весов 2^53 − 1 — точная, но не та', u64(10, 2n ** 53n - 1n), 'книга: сумма весов в заголовке не равна сумме записей'],
    ['сумма в заголовке не та', u64(10, 5n), 'книга: сумма весов в заголовке не равна сумме записей'],
    ['вес 0', u32(18 + 8, 0), 'книга: запись 0: вес 0'],
    ['итог выше капа', u32(30 + 4, CAP + 1), 'книга: запись 1: итог выше капа'],
  ])('гард: %s', (_, bytes, problem) => {
    expect(decodeBook(bytes, CAP)).toStrictEqual({ ok: false, problem });
  });

  it('запись: сид, итог и вес — u32, вес от 1; записей 1…80 000', () => {
    const many = (count: number) => Array.from({ length: count }, (_, seed) => ({ seed, payX100: 0, weight: 1 }));
    expect(rangeError(() => encodeBook([]))).toBe('записей 0, можно 1…80000');
    expect(rangeError(() => encodeBook(many(80_001)))).toBe('записей 80001, можно 1…80000');
    expect(
      [
        { seed: 1, payX100: 0, weight: 0 },
        { seed: 2 ** 32, payX100: 0, weight: 1 },
        { seed: -1, payX100: 0, weight: 1 },
        { seed: 1, payX100: 0.5, weight: 1 },
      ].map((record) => rangeError(() => encodeBook([record]))),
    ).toStrictEqual(new Array<string>(4).fill('запись 0: сид, итог и вес — u32, вес от 1'));
  });

  it('границы допустимого: одна запись; сид, итог и вес 2^32 − 1; ровно 80 000 записей — туда и обратно', () => {
    const top = decodeBook(encodeBook([{ seed: 2 ** 32 - 1, payX100: 2 ** 32 - 1, weight: 2 ** 32 - 1 }]), 2 ** 32 - 1);
    expect(top.ok ? [top.book.size, top.book.total, top.book.record(0)] : top.problem).toStrictEqual([
      1,
      2 ** 32 - 1,
      { seed: 2 ** 32 - 1, payX100: 2 ** 32 - 1, weight: 2 ** 32 - 1 },
    ]);
    const full = decodeBook(encodeBook(Array.from({ length: 80_000 }, (_, seed) => ({ seed, payX100: 0, weight: 1 }))), CAP);
    expect(full.ok ? [full.book.size, full.book.total, full.book.record(79_999).seed] : full.problem).toStrictEqual([80_000, 80_000, 79_999]);
  });

  it('сумма весов любой книги — точное целое: записей не больше 80 000, вес до 2^32 − 1 — произведение меньше 2^53', () => {
    expect(BOOK_MAX_RECORDS).toBe(80_000);
    expect(BOOK_MAX_RECORDS * (2 ** 32 - 1)).toBeLessThan(2 ** 53);
  });
});
