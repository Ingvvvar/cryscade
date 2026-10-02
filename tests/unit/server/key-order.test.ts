import { describe, expect, it } from 'vitest';
import { compareKeys, keyId, toKey } from '../../../src/server/key-order.ts';
import { NON_KEYS, ORDERED_KEYS, buildKey, buildNonKey, describeKey, returnedSpec } from '../../support/key-order-table.ts';

// Ключи по правилам IndexedDB (§6.6): что ключ, что нет, порядок и тождество. Ожидания — таблица, снятая пробой
// в Chrome for Testing 153 (tests/support/key-order-table.ts), а не код модуля.

const keys = ORDERED_KEYS.map((spec) => {
  const key = toKey(buildKey(spec));
  if (key === null) throw new Error(`не ключ: ${JSON.stringify(spec)}`);
  return key;
});

describe('toKey', () => {
  it('таблица — ключи, и каждый возвращается в виде курсора: двоичные — ArrayBuffer, даты — даты', () => {
    expect(keys.map(describeKey)).toStrictEqual(ORDERED_KEYS.map(returnedSpec));
  });

  it.each(NON_KEYS)('%s — не ключ', (name) => {
    expect(toKey(buildNonKey(name))).toBeNull();
  });

  it('копия, а не то же: дату, двоичные и массив снаружи не изменить', () => {
    const date = new Date(5);
    const bytes = new Uint8Array([1, 2]);
    const array = [1, [2]];
    const [dateKey, bytesKey, arrayKey] = [toKey(date), toKey(bytes), toKey(array)];
    date.setTime(6);
    bytes[0] = 9;
    (array[1] as number[]).push(3);
    expect([describeKey(dateKey), describeKey(bytesKey), describeKey(arrayKey)]).toStrictEqual([
      { date: 5 },
      { binary: [1, 2], as: 'buffer' },
      { array: [{ number: 1 }, { array: [{ number: 2 }] }] },
    ]);
  });

  it('тот же массив дважды рядом — ключ, как в Chrome: цикл — только через предка', () => {
    const inner = [1];
    expect(describeKey(toKey([inner, inner]))).toStrictEqual({ array: [{ array: [{ number: 1 }] }, { array: [{ number: 1 }] }] });
  });

  it('вид двоичных — только срез самого вида', () => {
    const view = new Uint8Array([7, 8, 9, 10]).subarray(1, 3);
    expect(describeKey(toKey(view))).toStrictEqual({ binary: [8, 9], as: 'buffer' });
  });

  it('отсоединённый буфер — не ключ: его байтов больше нет', () => {
    const buffer = new ArrayBuffer(4);
    buffer.transfer();
    expect(buffer.detached).toBe(true);
    expect(toKey(buffer)).toBeNull();
  });
});

describe('compareKeys', () => {
  it('порядок таблицы: каждый ключ меньше каждого следующего и равен себе', () => {
    const verdicts: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        const expected = i < j ? -1 : i > j ? 1 : 0;
        const actual = compareKeys(keys[i] as IDBValidKey, keys[j] as IDBValidKey);
        if (actual !== expected) verdicts.push(`${String(i)}↔${String(j)}: ${String(actual)}, ждали ${String(expected)}`);
      }
    }
    expect(verdicts).toStrictEqual([]);
    expect(keys.length).toBe(37);
  });

  it('−0 и 0 — один ключ; Uint8Array и ArrayBuffer с теми же байтами — один ключ', () => {
    expect(compareKeys(-0, 0)).toBe(0);
    expect(compareKeys(new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer)).toBe(0);
  });
});

describe('keyId', () => {
  it('разные ключи таблицы — разные строки', () => {
    expect(new Set(keys.map(keyId)).size).toBe(keys.length);
  });

  it('равные ключи — одна строка: −0 и 0, вид и буфер, две даты, два массива', () => {
    const pairs: [unknown, unknown][] = [
      [-0, 0],
      [new Uint8Array([1, 2]), new Uint8Array([1, 2]).buffer],
      [new Date(3), new Date(3)],
      [[1, ['a']], [1, ['a']]],
    ];
    expect(pairs.map(([a, b]) => keyId(toKey(a) as IDBValidKey) === keyId(toKey(b) as IDBValidKey))).toStrictEqual([true, true, true, true]);
  });

  it('строка с запятой и скобкой внутри массива не сливается с двумя строками', () => {
    expect(keyId(['a","b'])).not.toBe(keyId(['a', 'b']));
  });

  it('байт — две цифры hex, элементы массива — через запятую: соседние ключи не склеиваются', () => {
    const bytes = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer;
    expect([keyId(bytes(0x01, 0x23)), keyId(bytes(0x12, 0x03))]).toStrictEqual(['b0123', 'b1203']);
    expect([keyId([bytes(0xab), new Date(5)]), keyId([bytes(0xab, 0xd5)])]).toStrictEqual(['a[bab,d5]', 'a[babd5]']);
  });
});
