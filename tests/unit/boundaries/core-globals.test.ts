import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findForbiddenGlobals } from './core-globals.ts';
import { scanRepo } from './graph.ts';

const names = (text: string): string[] => findForbiddenGlobals('src/core/x.ts', text).map((f) => f.name);

describe('findForbiddenGlobals', () => {
  it.each([
    ['const r = Math.random();', ['Math.random']],
    ["const r = Math['random']();", ['Math']],
    ['const { random } = Math;', ['Math']],
    ['const m = Math; m.random();', ['Math']],
    ['const t = Date.now();', ['Date']],
    ['const d = new Date();', ['Date']],
    ['const s = Date();', ['Date']],
    ['let d: Date | undefined;', ['Date']],
    ['const t = performance.now();', ['performance']],
    ['crypto.getRandomValues(buf);', ['crypto']],
    ['const c = { crypto };', ['crypto']],
    ['window.addEventListener("x", f);', ['window']],
    ['document.body.append(x);', ['document']],
    ['const ua = navigator.userAgent;', ['navigator']],
    ['self.postMessage(1);', ['self']],
    ['const c = globalThis.crypto;', ['globalThis']],
  ])('%s', (text, expected) => {
    expect(names(text)).toEqual(expected);
  });

  it('имена свойств и безопасный Math не трогает', () => {
    expect(
      names(
        [
          'const a = Math.floor(1.5) + Math.max(1, 2);',
          'const b = obj.random + obj.document + obj.Date;',
          'const c = { crypto: 1, window: 2, Date: 3 };',
          'const { performance: p } = stats;',
          'interface I { navigator: string; self(): void }',
          "const s = 'Math.random() Date.now()'; // performance.now()",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('номер строки — с единицы', () => {
    expect(findForbiddenGlobals('src/core/x.ts', '\nconst t = Date.now();')).toEqual([{ name: 'Date', line: 2 }]);
  });
});

describe('core/ на настоящем репозитории', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = scanRepo(root, ['src/core']).files;

  it('обход нашёл файлы', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('запрещённых глобалов нет', () => {
    const findings = files.flatMap((file) =>
      findForbiddenGlobals(file, readFileSync(path.join(root, file), 'utf8')).map((f) => `${file}:${String(f.line)} ${f.name}`),
    );
    expect(findings).toEqual([]);
  });
});
