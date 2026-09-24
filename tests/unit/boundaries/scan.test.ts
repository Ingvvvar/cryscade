import { describe, expect, it } from 'vitest';
import { extractImports, resolveImport } from './graph.ts';

const specs = (text: string): (string | null)[] => extractImports('src/x.ts', text).map((ref) => ref.specifier);

describe('extractImports', () => {
  it.each([
    ['import a from "./a.ts";', ['./a.ts']],
    ['import "./side.ts";', ['./side.ts']],
    ['import type { T } from "../core/engine/t.ts";', ['../core/engine/t.ts']],
    ['export * from "./x.ts";', ['./x.ts']],
    ['export { y } from "./y.ts";', ['./y.ts']],
    ['type M = typeof import("./m.ts");', ['./m.ts']],
    ['const m = await import("../server/s.ts");', ['../server/s.ts']],
    ['const m = await import(`../server/t.ts`);', ['../server/t.ts']],
    ['const r = require("./r.ts");', ['./r.ts']],
  ])('%s', (text, expected) => {
    expect(specs(text)).toEqual(expected);
  });

  it('помечает непроверяемые импорты: import(выражение) и import.meta.glob', () => {
    expect(specs('const name = "./a.ts"; await import(name);')).toEqual([null]);
    expect(specs('const all = import.meta.glob("../server/*.ts");')).toEqual([null]);
  });

  it('new URL(…, import.meta.url) — не импорт', () => {
    expect(specs("new Worker(new URL('../server/worker.ts', import.meta.url), { type: 'module' });")).toEqual([]);
  });

  it('комментарии и строки — не импорты', () => {
    expect(specs('// import x from "./c.ts";\nconst s = \'import y from "./s.ts"\';')).toEqual([]);
  });

  it('номер строки — с единицы', () => {
    expect(extractImports('src/x.ts', '\n\nimport "./a.ts";')).toEqual([{ specifier: './a.ts', line: 3 }]);
  });
});

describe('resolveImport', () => {
  const files = new Set(['src/core/engine/grid.ts', 'src/ui/App.tsx', 'src/client/index.ts']);
  const exists = (file: string): boolean => files.has(file);

  it.each([
    ['src/client/a.ts', '../core/engine/grid.ts', { kind: 'file', path: 'src/core/engine/grid.ts' }],
    ['src/client/a.ts', '../core/engine/grid', { kind: 'file', path: 'src/core/engine/grid.ts' }],
    ['src/ui/main.tsx', './App', { kind: 'file', path: 'src/ui/App.tsx' }],
    ['src/ui/main.tsx', '../client', { kind: 'file', path: 'src/client/index.ts' }],
    ['src/ui/main.tsx', '/src/client/index.ts', { kind: 'file', path: 'src/client/index.ts' }],
    ['src/ui/main.tsx', './App.tsx?raw', { kind: 'file', path: 'src/ui/App.tsx' }],
    ['src/ui/main.tsx', './missing.ts', { kind: 'unresolved', specifier: './missing.ts' }],
    ['src/ui/main.tsx', 'react-dom/client', { kind: 'package', name: 'react-dom' }],
    ['src/ui/main.tsx', '@fontsource-variable/manrope/wght.css', { kind: 'package', name: '@fontsource-variable/manrope' }],
    ['tools/a.ts', 'node:fs/promises', { kind: 'package', name: 'node:fs' }],
    ['src/ui/main.tsx', null, { kind: 'unresolved', specifier: null }],
  ])('%s + %s', (from, specifier, expected) => {
    expect(resolveImport(from, specifier, exists)).toEqual(expected);
  });
});
