import { describe, expect, it } from 'vitest';
import { MemoryStorage, StorageError, type CommitBatch, type WriteOp } from '../../../src/server/index.ts';

// Хранилище в памяти держит семантику IndexedDB, на которую опирается сервер: транзакция «всё или ничего» с условием
// по кошельку внутри неё, add не перезаписывает, уникальный индекс, порядок ключей и индексов, копии на входе и выходе.

const always = (): boolean => true;
const commit = (storage: MemoryStorage, ops: readonly WriteOp[], precondition: CommitBatch['precondition'] = always) =>
  storage.commit({ precondition, ops });

const round = (roundId: string, seq: number): { roundId: string; seq: number } => ({ roundId, seq });

describe('MemoryStorage', () => {
  it('новое хранилище пусто, хранилища — из миграций', () => {
    expect(new MemoryStorage().snapshot()).toStrictEqual({ wallet: [], rounds: [], keys: [], quarantine: [] });
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
    expect(storage.snapshot()).toStrictEqual({ wallet: [['main', { id: 'main', revision: 1 }]], rounds: [], keys: [], quarantine: [] });
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

  it('запись без ключа — ошибка', async () => {
    await expect(commit(new MemoryStorage(), [{ op: 'put', store: 'rounds', value: { seq: 1 } }])).rejects.toThrow(StorageError);
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
