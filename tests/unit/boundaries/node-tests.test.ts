import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packagesReached, scanRepo, type ImportRef, type Target } from './graph.ts';

// Тесты в Node не тянут Pixi (§3): Pixi — только в src/render/pixi/, остальной render/ и всё, что импортируют
// тесты, без него. Проверка — замыкание импортов каждого тестового файла, по тому же разбору, что граф §3.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const scan = scanRepo(ROOT, ['src', 'tools', 'tests']);
const tests = scan.files.filter((file) => file.startsWith('tests/') && /\.(test|spec)\.tsx?$/.test(file));

describe('тесты в Node не тянут pixi.js', () => {
  it('обход нашёл тестовые файлы, и они доходят до render/ и ui/', () => {
    expect(tests.length).toBeGreaterThan(0);
    const reached = new Set(tests.flatMap((file) => scan.graph.get(file) ?? []));
    expect([...reached].some((file) => file.startsWith('src/render/'))).toBe(true);
    expect([...reached].some((file) => file.startsWith('src/ui/'))).toBe(true);
  });

  it('ни из одного теста не достижим pixi.js', () => {
    expect(tests.filter((file) => packagesReached(scan, file).has('pixi.js'))).toEqual([]);
  });

  it('обход находит pixi.js через посредников', () => {
    const ref: ImportRef = { specifier: 'x', line: 1 };
    const pkg = (name: string): { ref: ImportRef; target: Target } => ({ ref, target: { kind: 'package', name } });
    const synthetic = {
      graph: new Map([
        ['tests/unit/a.test.ts', ['src/render/layout.ts']],
        ['src/render/layout.ts', ['src/render/pixi/view.ts']],
        ['src/render/pixi/view.ts', []],
      ]),
      imports: new Map([
        ['tests/unit/a.test.ts', [pkg('vitest')]],
        ['src/render/pixi/view.ts', [pkg('pixi.js')]],
      ]),
    };
    expect([...packagesReached(synthetic, 'tests/unit/a.test.ts')].sort()).toStrictEqual(['pixi.js', 'vitest']);
    expect(packagesReached(synthetic, 'src/render/layout.ts').has('vitest')).toBe(false);
  });
});
