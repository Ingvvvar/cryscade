// Проверка раунда по шагам (§7): те же чистые функции, что у сервера (server/fairness.ts), и числа каждого шага — для
// инструмента проверки и разобранного примера docs/fairness.md. Криптография и движок приходят функциями: node:crypto и
// SeededRounds в инструменте, подставные в тестах.

import { winMinor } from '../../src/core/money.ts';
import type { Book } from '../../src/server/book.ts';
import { MAX_COUNTER, fairnessMessage, fromHex, pickValue, toHex } from '../../src/server/fairness.ts';

export interface VerifyInput {
  /** Раскрытый секрет сервера — 32 байта hex. */
  readonly secret: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly betMinor: number;
}

/** Один counter: сообщение HMAC, дайджест, первые 8 байт и решение границы. */
export interface CounterStep {
  readonly counter: number;
  readonly message: string;
  readonly digest: string;
  /** Первые 8 байт дайджеста hex и они же — uint64 big-endian десятичной строкой. */
  readonly head: string;
  readonly value: string;
  /** Точка на накопленных весах; null — значение за границей, следующий counter. */
  readonly point: number | null;
}

export interface VerifySteps {
  /** SHA-256 секрета — с ним сверяют опубликованное до игры обязательство. */
  readonly commitment: string;
  readonly records: number;
  readonly total: number;
  /** floor(2^64 / W) и граница равномерности floor(2^64 / W) · W — десятичными строками. */
  readonly quotient: string;
  readonly limit: string;
  readonly counters: readonly CounterStep[];
  readonly point: number;
  readonly index: number;
  /** Накопленный вес записей до выбранной и с ней: before ≤ point < after. */
  readonly before: number;
  readonly after: number;
  readonly seed: number;
  readonly payX100: number;
  readonly weight: number;
  /** Выплата, которую движок даёт по сиду записи: обязана совпасть с payX100 книги. */
  readonly enginePayX100: number;
  readonly betMinor: number;
  readonly winMinor: number;
}

export type Hmac = (key: Uint8Array, message: Uint8Array) => Uint8Array;

export interface VerifyPorts {
  readonly hmac: Hmac;
  readonly sha256: (bytes: Uint8Array) => Uint8Array;
  /** Движок: выплата раунда по сиду, в сотых ставки. */
  readonly play: (seed: number) => number;
}

export function verifySteps(input: VerifyInput, book: Book, ports: VerifyPorts): VerifySteps {
  const { hmac, sha256 } = ports;
  const key = fromHex(input.secret);
  const total = BigInt(book.total);
  const quotient = (1n << 64n) / total;
  const counters: CounterStep[] = [];
  for (let counter = 0; counter < MAX_COUNTER; counter++) {
    const message = fairnessMessage(input.clientSeed, input.nonce, counter);
    const digest = hmac(key, message);
    const head = toHex(digest.subarray(0, 8));
    const point = pickValue(digest, book.total);
    counters.push({ counter, message: new TextDecoder().decode(message), digest: toHex(digest), head, value: BigInt(`0x${head}`).toString(), point });
    if (point === null) continue;
    const index = book.indexOf(point);
    let before = 0;
    for (let at = 0; at < index; at++) before += book.record(at).weight;
    const record = book.record(index);
    return {
      commitment: toHex(sha256(key)),
      records: book.size,
      total: book.total,
      quotient: quotient.toString(),
      limit: (quotient * total).toString(),
      counters,
      point,
      index,
      before,
      after: before + record.weight,
      seed: record.seed,
      payX100: record.payX100,
      weight: record.weight,
      enginePayX100: ports.play(record.seed),
      betMinor: input.betMinor,
      winMinor: winMinor(input.betMinor, record.payX100),
    };
  }
  throw new Error(`${String(MAX_COUNTER)} значений подряд за границей равномерности`);
}

export interface VerifyReport {
  readonly lines: readonly string[];
  /** Обязательство (если дано) и движок сошлись. */
  readonly ok: boolean;
}

/** Шаги словами и числами; commitment — обязательство, опубликованное до раунда, null — не дано. */
export function renderSteps(steps: VerifySteps, bookPath: string, commitment: string | null): VerifyReport {
  const W = String(steps.total);
  const promised = commitment === null || commitment === steps.commitment;
  const engine = steps.enginePayX100 === steps.payX100;
  const lines = [`Книга ${bookPath}: записей ${String(steps.records)}, W = ${W}`];
  if (commitment === null) lines.push(`1. SHA-256(секрет) = ${steps.commitment} — сверь с обязательством, опубликованным до раунда`);
  else lines.push(`1. SHA-256(секрет) = ${steps.commitment} — ${promised ? 'совпадает с обязательством' : `НЕ совпадает с обязательством ${commitment}`}`);
  for (const step of steps.counters) {
    lines.push(
      `2. counter ${String(step.counter)}: HMAC-SHA256(секрет, «${step.message}») = ${step.digest}`,
      `   первые 8 байт ${step.head} = ${step.value}`,
      `   граница floor(2^64 / W) · W = ${steps.quotient} · ${W} = ${steps.limit}: ${step.point === null ? 'не меньше — следующий counter' : 'меньше — значение берём'}`,
    );
    if (step.point !== null) lines.push(`   точка = ${step.value} mod ${W} = ${String(step.point)}`);
  }
  lines.push(
    `3. индекс книги ${String(steps.index)}: накопленный вес до записи ${String(steps.before)} ≤ точка ${String(steps.point)} < ${String(steps.after)} с записью`,
    `4. запись ${String(steps.index)}: сид ${String(steps.seed)}, выплата ${String(steps.payX100)} сотых ставки, вес ${String(steps.weight)}; движок по сиду — ${String(steps.enginePayX100)}, ${engine ? 'совпадает' : 'НЕ совпадает'}`,
    `5. выигрыш при ставке ${String(steps.betMinor)}: floor(${String(steps.betMinor)} · ${String(steps.payX100)} / 100) = ${String(steps.winMinor)} минимальных единиц`,
    `Повтор записи: ?replay=book:${String(steps.index)}`,
  );
  return { lines, ok: promised && engine };
}
