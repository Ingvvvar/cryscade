import { describe, expect, it } from 'vitest';
import { MemoryStorage, StorageError, type CommitBatch, type StoreName, type WriteOp } from '../../../src/server/index.ts';
import { NON_KEYS, ORDERED_KEYS, buildKey, buildNonKey, describeKey, returnedSpec } from '../../support/key-order-table.ts';

// Хранилище в памяти держит семантику IndexedDB, на которую опирается сервер: транзакция «всё или ничего» с условием
// по кошельку внутри неё, add не перезаписывает, уникальный индекс, порядок ключей и индексов, копии на входе и выходе.

const always = (): boolean => true;
const commit = (storage: MemoryStorage, ops: readonly WriteOp[], precondition: CommitBatch['precondition'] = always) =>
  storage.commit({ precondition, ops });

const round = (roundId: string, seq: number): { roundId: string; seq: number } => ({ roundId, seq });

/** Имя и текст ошибки, с которой отклонён промис: StorageError — как DataError и ConstraintError в IndexedDB. */
async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? [error.name, error.message] : ['не Error', String(error)];
  }
  return ['не отклонён', ''];
}

describe('MemoryStorage', () => {
  it('новое хранилище пусто, хранилища — из миграций', () => {
    expect(new MemoryStorage().snapshot()).toStrictEqual({ wallet: [], rounds: [], keys: [], quarantine: [], fairness: [], secrets: [] });
  });

  it('durable: по умолчанию нет — это режим без IndexedDB', () => {
    expect(new MemoryStorage().durable).toBe(false);
    expect(new MemoryStorage({ durable: true }).durable).toBe(true);
  });

  it('get: нет записи — undefined', async () => {
    expect(await new MemoryStorage().get('wallet', 'main')).toBeUndefined();
  });

  it('копии на входе и на выходе: снаружи запись не изменить', async () => {
    const storage = new MemoryStorage();
    const value = { id: 'main', balanceMinor: 5, nested: [1] };
    await commit(storage, [{ op: 'put', store: 'wallet', value }]);
    value.nested.push(2);
    value.balanceMinor = 6;
    const read = (await storage.get('wallet', 'main')) as { nested: number[] };
    read.nested.push(3);
    expect(await storage.get('wallet', 'main')).toStrictEqual({ id: 'main', balanceMinor: 5, nested: [1] });
  });

  it('условие видит кошелёк внутри транзакции; false — conflict и ничего не записано', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'put', store: 'wallet', value: { id: 'main', revision: 1 } }]);
    const seen: unknown[] = [];
    const outcome = await commit(storage, [{ op: 'put', store: 'wallet', value: { id: 'main', revision: 2 } }, { op: 'add', store: 'keys', value: { key: 'k', roundId: 'r' } }], (stored) => {
      seen.push(stored);
      return false;
    });
    expect(outcome).toBe('conflict');
    expect(seen).toStrictEqual([{ id: 'main', revision: 1 }]);
    expect(storage.snapshot()).toStrictEqual({ wallet: [['main', { id: 'main', revision: 1 }]], rounds: [], keys: [], quarantine: [], fairness: [], secrets: [] });
  });

  it('условие на пустом месте получает undefined', async () => {
    const seen: unknown[] = [];
    await commit(new MemoryStorage(), [], (stored) => {
      seen.push(stored);
      return true;
    });
    expect(seen).toStrictEqual([undefined]);
  });

  it('всё или ничего: сбой посреди транзакции откатывает и то, что шло раньше', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'add', store: 'keys', value: { key: 'k1', roundId: 'r1' } }]);
    const before = storage.snapshot();
    const failed = commit(storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', revision: 9 } },
      { op: 'add', store: 'rounds', value: round('r2', 2) },
      { op: 'add', store: 'keys', value: { key: 'k1', roundId: 'r2' } },
    ]);
    await expect(failed).rejects.toThrow(StorageError);
    expect(storage.snapshot()).toStrictEqual(before);
  });

  it('add не перезаписывает, put — перезаписывает', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'add', store: 'rounds', value: round('r1', 1) }]);
    await expect(commit(storage, [{ op: 'add', store: 'rounds', value: { ...round('r1', 1), status: 'x' } }])).rejects.toThrow('уже есть');
    await commit(storage, [{ op: 'put', store: 'rounds', value: { ...round('r1', 1), status: 'closed' } }]);
    expect(await storage.get('rounds', 'r1')).toStrictEqual({ roundId: 'r1', seq: 1, status: 'closed' });
  });

  it('уникальный seq не пускает второй раунд на то же место, а свой же раунд переписать можно', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'add', store: 'rounds', value: round('r1', 1) }]);
    await expect(commit(storage, [{ op: 'add', store: 'rounds', value: round('r2', 1) }])).rejects.toThrow('индекс seq');
    await expect(commit(storage, [{ op: 'put', store: 'rounds', value: round('r1', 1) }])).resolves.toBe('committed');
  });

  it('запись без ключа — ошибка; не-объект — тоже она, а не TypeError', async () => {
    await expect(commit(new MemoryStorage(), [{ op: 'put', store: 'rounds', value: { seq: 1 } }])).rejects.toThrow(StorageError);
    expect(await failure(commit(new MemoryStorage(), [{ op: 'put', store: 'rounds', value: { seq: 1 } }]))).toStrictEqual([
      'StorageError',
      'rounds: у записи нет ключа roundId',
    ]);
    for (const value of [null, undefined, 7]) {
      expect(await failure(commit(new MemoryStorage(), [{ op: 'put', store: 'keys', value: value as unknown as object }]))).toStrictEqual([
        'StorageError',
        'keys: у записи нет ключа key',
      ]);
    }
  });

  it('не-ключ в get, delete и границах диапазона — ошибка, как DataError: где и в каком хранилище', async () => {
    const storage = new MemoryStorage();
    const object = {} as unknown as IDBValidKey;
    expect(await failure(storage.get('rounds', object))).toStrictEqual(['StorageError', 'rounds: get: не ключ IndexedDB']);
    expect(await failure(commit(storage, [{ op: 'delete', store: 'keys', key: object }]))).toStrictEqual(['StorageError', 'keys: delete: не ключ IndexedDB']);
    expect(await failure(storage.keysByIndex('rounds', 'seq', { lower: object, upper: 1 }))).toStrictEqual(['StorageError', 'нижняя граница: не ключ IndexedDB']);
    expect(await failure(storage.lastByIndex('rounds', 'seq', { lower: 1, upper: object }, 5))).toStrictEqual(['StorageError', 'верхняя граница: не ключ IndexedDB']);
  });

  it('нижняя граница выше верхней — ошибка, как DataError у IDBKeyRange.bound; равные — годный диапазон', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'put', store: 'rounds', value: round('r1', 1) }]);
    expect(await failure(storage.keysByIndex('rounds', 'seq', { lower: 2, upper: 1 }))).toStrictEqual(['StorageError', 'rounds: нижняя граница диапазона выше верхней']);
    expect(await failure(storage.lastByIndex('keys', 'roundId', { lower: 'b', upper: 'a' }, 5))).toStrictEqual(['StorageError', 'keys: нижняя граница диапазона выше верхней']);
    expect(await storage.keysByIndex('rounds', 'seq', { lower: 1, upper: 1 })).toStrictEqual(['r1']);
  });

  it('нет такого хранилища — ошибка с его именем', async () => {
    expect(await failure(new MemoryStorage().get('nope' as StoreName, 1))).toStrictEqual(['StorageError', 'нет хранилища nope']);
  });

  it('ключи на выходе — копии: массив ключа из индекса и снимка снаружи не изменить', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'put', store: 'rounds', value: { roundId: [1, 2], seq: 1 } }]);
    const [first] = await storage.keysByIndex('rounds', 'seq', { lower: 1, upper: 1 });
    (first as number[]).push(3);
    const [last] = await storage.lastByIndex('rounds', 'seq', { lower: 1, upper: 1 }, 1);
    (last?.key as number[]).push(4);
    (storage.snapshot().rounds[0]?.[0] as number[]).push(5);
    expect(await storage.keysByIndex('rounds', 'seq', { lower: 1, upper: 1 })).toStrictEqual([[1, 2]]);
  });

  it('delete: запись уходит, отсутствующая — не ошибка', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'add', store: 'keys', value: { key: 'k1', roundId: 'r1' } }]);
    await commit(storage, [
      { op: 'delete', store: 'keys', key: 'k1' },
      { op: 'delete', store: 'keys', key: 'нет' },
    ]);
    expect(storage.snapshot().keys).toStrictEqual([]);
  });

  it('карантин: ключи по возрастанию с единицы', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [
      { op: 'add', store: 'quarantine', value: { reason: 'a' } },
      { op: 'add', store: 'quarantine', value: { reason: 'b' } },
    ]);
    await commit(storage, [{ op: 'add', store: 'quarantine', value: { reason: 'c' } }]);
    expect(storage.snapshot().quarantine).toStrictEqual([
      [1, { reason: 'a' }],
      [2, { reason: 'b' }],
      [3, { reason: 'c' }],
    ]);
  });

  it('индекс seq: диапазон включительно, по возрастанию; последние — по убыванию и не больше limit', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [
      { op: 'add', store: 'rounds', value: round('b', 3) },
      { op: 'add', store: 'rounds', value: round('a', 10) },
      { op: 'add', store: 'rounds', value: round('c', 1) },
      { op: 'add', store: 'rounds', value: round('d', 2) },
      // Значение индекса не число — в числовой диапазон не попадает, как в IndexedDB.
      { op: 'add', store: 'rounds', value: { roundId: 'e', seq: '5' } },
      { op: 'add', store: 'rounds', value: { roundId: 'f' } },
    ]);
    expect(await storage.keysByIndex('rounds', 'seq', { lower: 2, upper: 10 })).toStrictEqual(['d', 'b', 'a']);
    const last = await storage.lastByIndex('rounds', 'seq', { lower: 1, upper: Number.MAX_SAFE_INTEGER }, 2);
    expect(last).toStrictEqual([
      { key: 'a', indexKey: 10, value: round('a', 10) },
      { key: 'b', indexKey: 3, value: round('b', 3) },
    ]);
  });

  it('неуникальный индекс ключей по roundId: все ключи раунда, по возрастанию ключа', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [
      { op: 'add', store: 'keys', value: { key: 'k2', roundId: 'r1' } },
      { op: 'add', store: 'keys', value: { key: 'k1', roundId: 'r1' } },
      { op: 'add', store: 'keys', value: { key: 'k3', roundId: 'r2' } },
    ]);
    expect(await storage.keysByIndex('keys', 'roundId', { lower: 'r1', upper: 'r1' })).toStrictEqual(['k1', 'k2']);
  });

  it('порядок ключей как в IndexedDB: числа раньше строк, строки — по кодовым единицам', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [
      { op: 'add', store: 'keys', value: { key: 'b', roundId: 'x' } },
      { op: 'add', store: 'keys', value: { key: 10, roundId: 'x' } },
      { op: 'add', store: 'keys', value: { key: 'B', roundId: 'x' } },
      { op: 'add', store: 'keys', value: { key: 9, roundId: 'x' } },
    ]);
    expect(storage.snapshot().keys.map(([key]) => key)).toStrictEqual([9, 10, 'B', 'b']);
  });

  it('ошибка — отклонённый промис, а не исключение в вызывающем', () => {
    const storage = new MemoryStorage();
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = storage.keysByIndex('wallet', 'seq', { lower: 1, upper: 2 });
    }).not.toThrow();
    return expect(promise).rejects.toThrow('нет индекса seq');
  });
});

describe('MemoryStorage: ключи всех типов IndexedDB (таблица пробы Chrome 153)', () => {
  /** Порядок вставки перемешан: порядок индекса — от ключей, а не от вставки. */
  const shuffled = ORDERED_KEYS.map((spec, index) => ({ spec, index })).sort((a, b) => ((a.index * 7) % 37) - ((b.index * 7) % 37));

  async function indexed(): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    const ops: WriteOp[] = shuffled.map(({ spec, index }) => ({ op: 'add', store: 'rounds', value: { roundId: `k${String(index)}`, seq: buildKey(spec) } }));
    ops.push(...NON_KEYS.map((name): WriteOp => ({ op: 'add', store: 'rounds', value: { roundId: `n-${name.replaceAll(' ', '-')}`, seq: buildNonKey(name) } })));
    await commit(storage, ops);
    return storage;
  }

  it('descend: весь индекс сверху вниз в порядке таблицы; не-ключи хранятся, но индексу не видны', async () => {
    const storage = await indexed();
    const found = await storage.descend('rounds', 'seq', () => false);
    expect(found.map((entry) => describeKey(entry.indexKey))).toStrictEqual(ORDERED_KEYS.map(returnedSpec).reverse());
    expect(found.map((entry) => entry.key)).toStrictEqual(ORDERED_KEYS.map((_spec, index) => `k${String(index)}`).reverse());
    expect(storage.snapshot().rounds).toHaveLength(ORDERED_KEYS.length + NON_KEYS.length);
  });

  it('descend останавливается на первой записи, где stop — да, включительно', async () => {
    const storage = await indexed();
    const seen: unknown[] = [];
    const found = await storage.descend('rounds', 'seq', (key) => {
      seen.push(describeKey(key));
      return typeof key === 'number';
    });
    expect(found.map((entry) => describeKey(entry.indexKey))).toStrictEqual(seen);
    expect(found.at(-1)?.indexKey).toBe(Number.POSITIVE_INFINITY);
    expect(found).toHaveLength(ORDERED_KEYS.length - 13);
  });

  it('первичные ключи всех типов: запись находится равным ключом-копией, снимок — в порядке таблицы', async () => {
    const storage = new MemoryStorage();
    await commit(storage, shuffled.map(({ spec, index }): WriteOp => ({ op: 'put', store: 'rounds', value: { roundId: buildKey(spec), seq: index } })));
    const found = await Promise.all(ORDERED_KEYS.map((spec) => storage.get('rounds', buildKey(spec) as IDBValidKey)));
    expect(found.map((value) => (value as { seq: number }).seq)).toStrictEqual(ORDERED_KEYS.map((_spec, index) => index));
    expect(storage.snapshot().rounds.map(([key]) => describeKey(key))).toStrictEqual(ORDERED_KEYS.map(returnedSpec));
  });

  it('не-ключ как ключ записи — ошибка, как DataError', async () => {
    expect(NON_KEYS.length).toBeGreaterThan(0);
    for (const name of NON_KEYS) {
      await expect(commit(new MemoryStorage(), [{ op: 'put', store: 'rounds', value: { roundId: buildNonKey(name), seq: 1 } }])).rejects.toThrow(StorageError);
    }
  });

  it.each([
    ['массив [0] — второй такой же массив', [0], [0]],
    ['−0 и 0', -0, 0],
    ['две даты с одним временем', new Date(0), new Date(0)],
    ['Uint8Array и ArrayBuffer с теми же байтами', new Uint8Array([1]), new Uint8Array([1]).buffer],
  ])('уникальный индекс по значению ключа: %s', async (_what, first, second) => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'add', store: 'rounds', value: { roundId: 'a', seq: first } }]);
    await expect(commit(storage, [{ op: 'add', store: 'rounds', value: { roundId: 'b', seq: second } }])).rejects.toThrow('индекс seq');
  });

  it('уникальный индекс: запись, чей seq — не ключ, не занимает место даты 0', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'add', store: 'rounds', value: { roundId: 'a', seq: null } }]);
    await expect(commit(storage, [{ op: 'add', store: 'rounds', value: { roundId: 'b', seq: new Date(0) } }])).resolves.toBe('committed');
  });

  it('ключи раунда по индексу roundId — и для ключа-массива', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [
      { op: 'add', store: 'keys', value: { key: 'k1', roundId: [7, 'x'] } },
      { op: 'add', store: 'keys', value: { key: 'k2', roundId: [7, 'y'] } },
    ]);
    expect(await storage.keysByIndex('keys', 'roundId', { lower: [7, 'x'], upper: [7, 'x'] })).toStrictEqual(['k1']);
  });

  it('delete по равному ключу-копии', async () => {
    const storage = new MemoryStorage();
    await commit(storage, [{ op: 'put', store: 'rounds', value: { roundId: [1, new Date(2)], seq: 1 } }]);
    await commit(storage, [{ op: 'delete', store: 'rounds', key: [1, new Date(2)] }]);
    expect(storage.snapshot().rounds).toStrictEqual([]);
  });
});

