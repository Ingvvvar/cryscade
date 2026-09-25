import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRepo } from '../boundaries/graph.ts';
import { scanAllocations } from './alloc-scan.ts';

const kinds = (text: string): string[] => scanAllocations('x.ts', text).findings.map((finding) => finding.kind);

describe('scanAllocations', () => {
  it.each([
    ['class A { m() { const x = []; } }', ['литерал массива']],
    ['class A { m() { return { a: 1 }; } }', ['литерал объекта']],
    ['class A { m() { return new Uint8Array(4); } }', ['new']],
    ['class A { m() { return () => 1; } }', ['замыкание']],
    ['class A { m(xs) { return f(...xs); } }', ['spread']],
    ['class A { m(x) { return `x${x}`; } }', ['шаблонная строка']],
    ["class A { m(x) { return 'x' + x; } }", ['склейка строк']],
    ['class A { m(xs) { for (const x of xs) use(x); } }', ['for...of']],
    ['class A { m(o) { for (const k in o) use(k); } }', ['for...in']],
    ['class A { m(pair) { const [a, b] = pair; return a + b; } }', ['деструктуризация массива']],
    ['class A { m() { let a = 1, b = 2; [a, b] = [b, a]; } }', ['литерал массива', 'литерал массива']],
    ['class A { m(buf) { return buf.subarray(0, 2); } }', ['.subarray()']],
    ['class A { m(xs) { return xs.slice(1); } }', ['.slice()']],
    ['class A { m(x = []) { return x; } }', ['литерал массива']],
    ['class A { get g() { return [1]; } }', ['литерал массива']],
    ['function f() { return /a/; }', ['регулярное выражение']],
    ['const f = () => [];', ['литерал массива']],
  ])('%s', (text, expected) => {
    expect(kinds(text)).toStrictEqual(expected);
  });

  it('конструктор, поля, throw и верхний уровень модуля не проверяет', () => {
    const scan = scanAllocations(
      'x.ts',
      [
        'const LIMIT = 10;',
        'const NAMES = ["a", "b"];',
        'class A {',
        '  readonly #buf = new Uint8Array(49);',
        '  static readonly empty = [];',
        '  constructor(n) { this.list = new Array(n); this.map = { a: [1] }; }',
        '  m(x) { if (x < 0) throw new RangeError(`плохо: ${String(x)}`); return this.#buf[x] ?? 0; }',
        '}',
      ].join('\n'),
    );
    expect(scan.findings).toStrictEqual([]);
    expect(scan.functions).toStrictEqual(['A.m']);
  });

  it('имя находки — класс и метод, строка — с единицы', () => {
    expect(scanAllocations('x.ts', 'class Grid {\n  #step() {\n    return [];\n  }\n}').findings).toStrictEqual([
      { owner: 'Grid.#step', kind: 'литерал массива', line: 3 },
    ]);
  });
});

describe('горячий путь движка без аллокаций', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  // Записывающий режим не горячий путь: один раунд на запрос, аллокации задаёт формат событий.
  const EXCLUDED = new Set(['src/core/engine/event-recorder.ts']);
  const files = scanRepo(root, ['src/core/engine', 'src/core/rng']).files.filter((file) => !EXCLUDED.has(file));
  const scans = files.map((file) => ({ file, ...scanAllocations(file, readFileSync(path.join(root, file), 'utf8')) }));
  const functions = scans.flatMap((scan) => scan.functions);

  it('обход нашёл файлы и функции, среди них — весь горячий цикл', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(functions).toEqual(
      expect.arrayContaining([
        'RoundEngine.play',
        'RoundEngine.#feature',
        'RoundEngine.#spin',
        'ClusterFinder.find',
        'ClusterFinder.#flood',
        'ClusterFinder.#visit',
        'ClusterTable.add',
        'SpotField.multiplier',
        'SpotField.bump',
        'Board.fill',
        'Board.explode',
        'Board.collapse',
        'Board.collectScatters',
        'RngSymbolSource.next',
        'WeightedPicker.pick',
        'SeededEngine.play',
        'Xoshiro128ss.reseed',
        'Xoshiro128ss.nextU32',
        'SplitMix32.next',
        'fmix32',
        'draw',
        'WatchdogSource.next',
        'StatsRecorder.begin',
        'StatsRecorder.fill',
        'StatsRecorder.win',
        'StatsRecorder.spots',
        'StatsRecorder.end',
        'StatsRecorder.addUsageTo',
        'StatsRecorder.addCascadesTo',
        'StatsRecorder.#closeSpin',
      ]),
    );
  });

  it('аллокаций нет', () => {
    const findings = scans.flatMap(({ file, findings: found }) =>
      found.map((finding) => `${file}:${String(finding.line)} ${finding.owner} — ${finding.kind}`),
    );
    expect(findings).toStrictEqual([]);
  });
});
