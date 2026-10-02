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
/** Фаза 6: честность — состояние и секреты; раунды v1 остаются как есть. */
const V2 = ['store fairness keyPath=id auto=false', 'store secrets keyPath=commitment auto=false'];

describe('схема IndexedDB', () => {
  it('БД cryscade версии 2', () => {
    expect(DB_NAME).toBe('cryscade');
    expect(DB_VERSION).toBe(2);
  });

  it('шаги миграций — версии по порядку с единицы, последняя — DB_VERSION', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toStrictEqual([1, 2]);
    expect(MIGRATIONS.at(-1)?.version).toBe(DB_VERSION);
  });

  it('с нуля: хранилища и индексы версий 1 и 2', () => {
    const target = new RecordingTarget();
    migrate(target, 0);
    expect(target.calls).toStrictEqual([...V1, ...V2]);
  });

  it('с версии 1 — только шаг версии 2: хранилища честности; данные v1 не трогаются', () => {
    const target = new RecordingTarget();
    migrate(target, 1);
    expect(target.calls).toStrictEqual(V2);
  });

  it('с каждой версии до последней — только недостающие шаги', () => {
    const fromLatest = new RecordingTarget();
    migrate(fromLatest, DB_VERSION);
    expect(fromLatest.calls).toStrictEqual([]);
  });

  it('до версии 1 — только её шаг: шагов выше целевой нет', () => {
    const target = new RecordingTarget();
    migrate(target, 0, 1);
    expect(target.calls).toStrictEqual(V1);
  });

  it.each([
    ['версия выше нашей — игрок откатился на старую сборку', 3, 'миграция: нет пути с версии 3 на 2'],
    ['отрицательная', -1, 'миграция: нет пути с версии -1 на 2'],
    ['дробная', 0.5, 'миграция: нет пути с версии 0.5 на 2'],
  ])('%s: RangeError', (_what, from, message) => {
    expect(() => {
      migrate(new RecordingTarget(), from);
    }).toThrow(new RangeError(message));
  });

  it('целевая версия выше нашей — RangeError', () => {
    expect(() => {
      migrate(new RecordingTarget(), 0, DB_VERSION + 1);
    }).toThrow(new RangeError('миграция: нет пути с версии 0 на 3'));
  });
});
