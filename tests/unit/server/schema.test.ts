import { describe, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION, MIGRATIONS, migrate, type UpgradeTarget } from '../../../src/server/index.ts';

// Миграции — данные (§6.6): шаги на подставном UpgradeTarget, от каждой версии до последней. worker.ts прогоняет те же
// шаги над IDBDatabase в onupgradeneeded, MemoryStorage — над своими хранилищами.

class RecordingTarget implements UpgradeTarget {
  readonly calls: string[] = [];

  createStore(store: string, options: { readonly keyPath: string | null; readonly autoIncrement: boolean }): void {
    this.calls.push(`store ${store} keyPath=${String(options.keyPath)} auto=${String(options.autoIncrement)}`);
  }

  createIndex(store: string, index: string, keyPath: string, unique: boolean): void {
    this.calls.push(`index ${store}.${index} keyPath=${keyPath} unique=${String(unique)}`);
  }
}

const V1 = [
  'store wallet keyPath=id auto=false',
  'store rounds keyPath=roundId auto=false',
  'index rounds.seq keyPath=seq unique=true',
  'store keys keyPath=key auto=false',
  'index keys.roundId keyPath=roundId unique=false',
  'store quarantine keyPath=null auto=true',
];

describe('схема IndexedDB', () => {
  it('БД cryscade версии 1', () => {
    expect(DB_NAME).toBe('cryscade');
    expect(DB_VERSION).toBe(1);
  });

  it('шаги миграций — версии по порядку с единицы, последняя — DB_VERSION', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toStrictEqual([1]);
    expect(MIGRATIONS.at(-1)?.version).toBe(DB_VERSION);
  });

  it('с нуля: хранилища и индексы версии 1', () => {
    const target = new RecordingTarget();
    migrate(target, 0);
    expect(target.calls).toStrictEqual(V1);
  });

  it('с каждой версии до последней — только недостающие шаги', () => {
    const fromLatest = new RecordingTarget();
    migrate(fromLatest, DB_VERSION);
    expect(fromLatest.calls).toStrictEqual([]);
  });

  it.each([
    ['версия выше нашей — игрок откатился на старую сборку', 2],
    ['отрицательная', -1],
    ['дробная', 0.5],
  ])('%s: RangeError', (_what, from) => {
    expect(() => {
      migrate(new RecordingTarget(), from);
    }).toThrow(RangeError);
  });

  it('целевая версия выше нашей — RangeError', () => {
    expect(() => {
      migrate(new RecordingTarget(), 0, DB_VERSION + 1);
    }).toThrow(RangeError);
  });
});
