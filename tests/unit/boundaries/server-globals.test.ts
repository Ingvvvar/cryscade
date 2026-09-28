import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_FORBIDDEN, findForbiddenGlobals } from './core-globals.ts';
import { scanRepo } from './graph.ts';

// Граница §3: браузер, время и случайность в server/ — только в worker.ts, корне композиции воркера.
// Остальной сервер получает их портами Storage, Lock, Clock, Entropy, Broadcast.

const WORKER = 'src/server/worker.ts';

const names = (text: string): string[] => findForbiddenGlobals('src/server/x.ts', text, SERVER_FORBIDDEN).map((f) => f.name);

describe('запрещённые глобалы server/', () => {
  it.each([
    ["const request = indexedDB.open('cryscade', 1);", ['indexedDB']],
    ['const range = IDBKeyRange.bound(1, 2);', ['IDBKeyRange']],
    ["await navigator.locks.request('cryscade-wallet', task);", ['navigator']],
    ["const channel = new BroadcastChannel('cryscade');", ['BroadcastChannel']],
    ['crypto.getRandomValues(buf);', ['crypto']],
    ['self.postMessage(1);', ['self']],
    ['postMessage(1);', ['postMessage']],
    ["const book = await fetch('/books/base.v1.bin.gz');", ['fetch']],
    ['setTimeout(tick, 10);', ['setTimeout']],
    ['const t = Date.now();', ['Date']],
    ['const t = performance.now();', ['performance']],
    ['const r = Math.random();', ['Math.random']],
    ['const g = globalThis.indexedDB;', ['globalThis']],
  ])('%s', (text, expected) => {
    expect(names(text)).toEqual(expected);
  });

  it('поля записей и порты — не глобалы', () => {
    expect(
      names(
        [
          'const at = this.#clock.now();',
          'const seed = ports.entropy.seed();',
          'const c = { indexedDB: 1, fetch: 2 };',
          'interface P { readonly crypto: string; setTimeout(): void }',
          'const copy = structuredClone(value);',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('server/ на настоящем репозитории', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const all = scanRepo(root, ['src/server']).files;
  const files = all.filter((file) => file !== WORKER);

  it('обход нашёл файлы сервера и сам worker.ts', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(all).toContain(WORKER);
  });

  it('вне worker.ts запрещённых глобалов нет', () => {
    const findings = files.flatMap((file) =>
      findForbiddenGlobals(file, readFileSync(path.join(root, file), 'utf8'), SERVER_FORBIDDEN).map(
        (f) => `${file}:${String(f.line)} ${f.name}`,
      ),
    );
    expect(findings).toEqual([]);
  });
});
