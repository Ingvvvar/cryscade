import { createHash, createHmac } from 'node:crypto';
import type { Crypto } from '../../src/server/ports.ts';

// Порт криптографии сервера на node:crypto — для тестов и инструментов (§7): в воркере тот же порт — WebCrypto.

export class NodeCrypto implements Crypto {
  hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(createHmac('sha256', key).update(message).digest()));
  }

  sha256(data: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(createHash('sha256').update(data).digest()));
  }
}

/**
 * Байты по сценарию: вызов k — первые байты SHA-256 строки «соль:k». Детерминированно, различимо между вызовами и между
 * вкладками (соль — имя вкладки): у двух вкладок одного стенда секреты не совпадают, как не совпали бы настоящие.
 */
export class ScriptedBytes {
  readonly #salt: string;
  #calls = 0;

  constructor(salt = '') {
    this.#salt = salt;
  }

  next(length: number): Uint8Array {
    if (length > 32) throw new RangeError('сценарий байтов — не длиннее 32');
    const call = this.#calls++;
    return new Uint8Array(createHash('sha256').update(`${this.#salt}:${String(call)}`).digest().subarray(0, length));
  }
}
