import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeBook, encodeBook, type Book } from '../../../src/server/book.ts';
import { MAX_COUNTER, drawIndex, fairnessMessage, fromHex, pickValue, toHex } from '../../../src/server/fairness.ts';
import { NodeCrypto } from '../../support/node-crypto.ts';

// Честность §7. Эталон HMAC-SHA256 — векторы RFC 4231, файл скачан с первоисточника
// https://www.rfc-editor.org/rfc/rfc4231.txt (SHA-256 файла — литерал ниже), векторы разбираются из него же: порт
// сервера на node:crypto обязан дать их все. Выбор по байтам — чистые функции: uint64 big-endian, отбрасывание у
// границы floor(2^64 / W) · W, индекс по накопленным весам — ожидания посчитаны вручную или перебором.

const RFC_FILE = 'tests/reference/rfc4231.txt';
const RFC_SHA256 = '72178527ce93500e730bc8eb182b857e583096d652b64ece0879c52ba1df973b';

interface Vector {
  readonly name: string;
  readonly key: string;
  readonly data: string;
  readonly mac: string;
}

/** Поле раздела: hex с 18-й колонки строки метки и строк продолжения, до следующей метки или пустой строки. */
function field(lines: readonly string[], label: string): string {
  const start = lines.findIndex((line) => line.startsWith(`   ${label}`));
  if (start < 0) throw new Error(`нет поля ${label}`);
  let hex = '';
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (index > start && (/^ {3}\S/.test(line) || line.trim() === '')) break;
    hex += /^.{18}([0-9a-f]+)/.exec(line)?.[1] ?? '';
  }
  return hex;
}

function rfcVectors(text: string): Vector[] {
  const sections = text.split(/^4\.\d+\. {2}Test Case /m).slice(1);
  return sections.map((section) => {
    const lines = section.split('\n');
    return { name: `случай ${lines[0]?.trim() ?? ''}`, key: field(lines, 'Key'), data: field(lines, 'Data'), mac: field(lines, 'HMAC-SHA-256') };
  });
}

describe('HMAC-SHA256: RFC 4231', () => {
  const text = readFileSync(RFC_FILE, 'utf8');
  const vectors = rfcVectors(text);

  it('файл — тот, что скачан с rfc-editor.org; в нём семь случаев', () => {
    expect(createHash('sha256').update(readFileSync(RFC_FILE)).digest('hex')).toBe(RFC_SHA256);
    expect(vectors.map((vector) => vector.name)).toStrictEqual(['случай 1', 'случай 2', 'случай 3', 'случай 4', 'случай 5', 'случай 6', 'случай 7']);
    expect(vectors.map((vector) => [vector.key.length / 2, vector.mac.length / 2])).toStrictEqual([
      [20, 32],
      [4, 32],
      [20, 32],
      [25, 32],
      [20, 16],
      [131, 32],
      [131, 32],
    ]);
  });

  it('порт сервера на node:crypto даёт все семь; случай 5 — первые 128 бит', async () => {
    const crypto = new NodeCrypto();
    for (const vector of vectors) {
      const mac = toHex(await crypto.hmacSha256(fromHex(vector.key), fromHex(vector.data)));
      expect(mac.slice(0, vector.mac.length), vector.name).toBe(vector.mac);
    }
  });

  it('SHA-256 порта — node:crypto: обязательство секрета', async () => {
    const secret = fromHex('cd'.repeat(32));
    expect(toHex(await new NodeCrypto().sha256(secret))).toBe(createHash('sha256').update(secret).digest('hex'));
  });
});

describe('выбор по байтам', () => {
  it('сообщение HMAC — ASCII «сид:nonce:counter»', () => {
    expect(fairnessMessage('Seed01', 5, 0)).toStrictEqual(new TextEncoder().encode('Seed01:5:0'));
    expect(new TextDecoder().decode(fairnessMessage('a', 12_345, 17))).toBe('a:12345:17');
  });

  it('hex туда и обратно; не hex — ошибка', () => {
    expect(toHex(Uint8Array.from([0, 15, 16, 255]))).toBe('000f10ff');
    expect(fromHex('000f10ff')).toStrictEqual(Uint8Array.from([0, 15, 16, 255]));
    expect(() => fromHex('abc')).toThrow(RangeError);
    expect(() => fromHex('AB')).toThrow(RangeError);
  });

  // W = 10: 2^64 mod 10 = 6, граница — 2^64 − 6. Значение 2^64 − 7 даёт (6 − 7) mod 10 = 9, 2^64 − 6 и выше — отброс.
  const digest = (value: bigint): Uint8Array => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setBigUint64(0, value, false);
    bytes.fill(0xee, 8);
    return bytes;
  };

  it.each([
    ['ноль', 0n, 10, 0],
    ['первые 8 байт — big-endian', 0x0102_0304_0506_0708n, 10, Number(0x0102_0304_0506_0708n % 10n)],
    ['последнее годное перед границей', 2n ** 64n - 7n, 10, 9],
    ['граница — отброс', 2n ** 64n - 6n, 10, null],
    ['наибольшее — отброс', 2n ** 64n - 1n, 10, null],
    ['W = 1: всё годно, индекс 0', 2n ** 64n - 1n, 1, 0],
  ] as const)('%s', (_, value, total, expected) => {
    expect(pickValue(digest(value), total)).toBe(expected);
  });

  it('сумма весов не целое от 1 и дайджест короче 8 байт — ошибка', () => {
    expect(() => pickValue(new Uint8Array(32), 0)).toThrow(RangeError);
    expect(() => pickValue(new Uint8Array(32), 1.5)).toThrow(RangeError);
    expect(() => pickValue(new Uint8Array(7), 10)).toThrow(RangeError);
  });

  const book = (): Book => {
    const read = decodeBook(
      encodeBook([
        { seed: 1, payX100: 0, weight: 5 },
        { seed: 0, payX100: 95, weight: 3 },
        { seed: 2, payX100: 190, weight: 2 },
      ]),
      500_000,
    );
    if (!read.ok) throw new Error(read.problem);
    return read.book;
  };

  it('отброшенное значение уходит на следующий counter: подставной источник байтов', async () => {
    const seen: string[] = [];
    // counter 0 — за границей, counter 1 — значение 7: накопленные веса 5 | 8 | 10 — запись 1.
    const hmac = (_key: Uint8Array, message: Uint8Array): Promise<Uint8Array> => {
      const text = new TextDecoder().decode(message);
      seen.push(text);
      return Promise.resolve(digest(text.endsWith(':0') ? 2n ** 64n - 1n : 7n));
    };
    expect(await drawIndex(hmac, new Uint8Array(32), 'Seed01', 4, book())).toStrictEqual({ index: 1, counter: 1 });
    expect(seen).toStrictEqual(['Seed01:4:0', 'Seed01:4:1']);
  });

  it('значения подряд за границей — ошибка после MAX_COUNTER попыток, а не вечный цикл', async () => {
    let calls = 0;
    const always = (): Promise<Uint8Array> => {
      calls += 1;
      return Promise.resolve(digest(2n ** 64n - 1n));
    };
    await expect(drawIndex(always, new Uint8Array(32), 'Seed01', 0, book())).rejects.toThrow(/значений подряд за границей/);
    expect(calls).toBe(MAX_COUNTER);
  });

  it('индекс — по накопленным весам, перебором: node:crypto HMAC для 50 nonce', async () => {
    const secret = fromHex('cd'.repeat(32));
    const b = book();
    const node = (key: Uint8Array, message: Uint8Array): Promise<Uint8Array> => Promise.resolve(new Uint8Array(createHmac('sha256', key).update(message).digest()));
    for (let nonce = 0; nonce < 50; nonce++) {
      const mac = createHmac('sha256', secret).update(`Seed01:${String(nonce)}:0`).digest();
      const value = mac.readBigUInt64BE(0) % 10n;
      const expected = value < 5n ? 0 : value < 8n ? 1 : 2;
      expect((await drawIndex(node, secret, 'Seed01', nonce, b)).index, `nonce ${String(nonce)}`).toBe(expected);
    }
  });
});
