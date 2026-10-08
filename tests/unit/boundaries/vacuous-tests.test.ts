import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertingHelpers, findVacuous, type TestSource } from './vacuous-tests.ts';

// Холостые тесты (фаза 9, аудит): в tests/ нет теста без проверок, проверки, которая не может упасть, skip, only, todo;
// намеренный провал (test.fail) — только у положительного контроля консоли; у каждой проверки по набору тест проверил
// размер набора. Сначала контроль: подброшенные холостые тесты находятся, честные — нет.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.posix.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const read = (file: string): TestSource => ({ path: file, text: readFileSync(path.join(ROOT, file), 'utf8') });

function scan(lines: readonly string[]): ReturnType<typeof findVacuous> {
  const sources: TestSource[] = [{ path: 'tests/x.test.ts', text: lines.join('\n') }];
  return findVacuous(sources, assertingHelpers(sources));
}

describe('холостые тесты', () => {
  it('контроль: без проверок, skip и only, проверки, которые не могут упасть, и намеренный провал находятся', () => {
    const found = scan([
      "import { expect, it } from 'vitest';",
      "it('без проверок', () => { const a = 1 + 1; void a; });",
      "it.skip('пропущен', () => { expect(2 + 2).toBe(4); });",
      "describe.only('группа', () => { it('в группе', () => { expect(2 + 2).toBe(4); }); });",
      "it.skipIf(true)('условно', () => { expect(2 + 2).toBe(4); });",
      "it('литерал', () => { expect(true).toBe(true); });",
      "it('сам с собой', () => { const a = [1]; expect(a).toStrictEqual(a); });",
      "it('без сопоставителя', async () => { const a = 1; expect(a); await expect(Promise.resolve(a)).resolves; });",
      "it('контроль провала', () => { test.fail(true, 'контроль'); expect(1 + 1).toBe(3); });",
    ]);
    expect(found.noAssertions).toStrictEqual(['tests/x.test.ts:2 без проверок']);
    expect(found.skipped).toStrictEqual(['tests/x.test.ts:3 it.skip', 'tests/x.test.ts:4 describe.only', 'tests/x.test.ts:5 it.skipIf']);
    expect(found.cannotFail).toStrictEqual(['tests/x.test.ts:6 литерал', 'tests/x.test.ts:7 сам с собой', 'tests/x.test.ts:8 без сопоставителя', 'tests/x.test.ts:8 без сопоставителя']);
    expect(found.expectedFailures).toStrictEqual(['tests/x.test.ts:9 контроль провала']);
    expect(found.unsizedScans).toStrictEqual([]);
  });

  it('контроль: скан без проверки размера находится — every, for…of, forEach, for до длины, every по `?? []`', () => {
    const found = scan([
      "import { expect, it } from 'vitest';",
      "it('every', () => { const xs: number[] = []; expect(xs.every((x) => x > 0)).toBe(true); });",
      "it('for of', () => { const xs: number[] = []; for (const x of xs) expect(x).toBe(1); });",
      "it('forEach', () => { const xs: number[] = []; xs.forEach((x) => { expect(x).toBe(1); }); });",
      "it('до длины', () => { const xs: number[] = []; for (let i = 0; i < xs.length; i++) expect(xs[i]).toBe(1); });",
      "it('?? []', () => { const g: { s?: number[] } = {}; expect([...(g.s ?? [])].every((x) => x === 0)).toBe(true); });",
    ]);
    expect(found.unsizedScans).toStrictEqual(['tests/x.test.ts:2 every', 'tests/x.test.ts:3 for of', 'tests/x.test.ts:4 forEach', 'tests/x.test.ts:5 до длины', 'tests/x.test.ts:6 ?? []']);
    expect([found.noAssertions, found.cannotFail, found.skipped, found.expectedFailures]).toStrictEqual([[], [], [], []]);
  });

  it('честные не находятся: хук, помощник через помощника, размер проверен, литерал и счётчик, строка с expect(true)', () => {
    const found = scan([
      "import { afterAll, expect, it } from 'vitest';",
      'afterAll(() => { console.log(1); });',
      "test.afterAll(() => { console.log(1); });",
      'function inner(n: number): void { expect(n).toBe(2); }',
      'const outer = (n: number): void => { inner(n); };',
      "it('помощник', () => { outer(2); });",
      "it('размер', () => { const xs = [1].filter(Boolean); expect(xs).toHaveLength(1); for (const x of xs) expect(x).toBe(1); });",
      "it('размер литералом', () => { const xs = [1].filter(Boolean); expect(xs.length).toBe(1); expect(xs.every((x) => x === 1)).toBe(true); });",
      'const CASES = [1, 2] as const;',
      "it('литералы', () => { for (const x of [1, 2]) expect(x).toBeLessThan(3); for (const x of CASES) expect(x).toBeLessThan(3); for (const [k] of Object.entries({ a: 1 })) expect(k).toBe('a'); });",
      "it('Map от литерала', () => { const graph = new Map([['a', 1]]); for (const [k] of graph) expect(k).toBe('a'); });",
      "it('счётчик', () => { for (let i = 0; i < 3; i++) expect(i).toBeLessThan(3); for (let i = 1; i <= 2; i++) expect(i).toBeLessThan(3); });",
      "it('строка', () => { const text = \"it('x', () => { expect(true).toBe(true); xs.every(f); })\"; expect(text).toHaveLength(53); });",
      "it('настоящий провал не путается с test.fail в строке', () => { expect('test.fail(true)').toContain('fail'); });",
    ]);
    expect(found).toStrictEqual({ noAssertions: [], cannotFail: ['tests/x.test.ts:14 настоящий провал не путается с test.fail в строке'], skipped: [], expectedFailures: [], unsizedScans: [] });
  });

  it('контроль: помощник находится по импорту и в своём файле, а не по совпадению имени в чужом', () => {
    const sources: TestSource[] = [
      { path: 'tests/support/check.ts', text: "import { expect } from 'vitest';\nexport function check(n: number): void { expect(n).toBe(2); }\nexport class Probe { verify(): void { expect(1).toBeTypeOf('number'); } }\n" },
      { path: 'tests/other.test.ts', text: "import { expect, it } from 'vitest';\nfunction run(): void { expect(1 + 1).toBe(2); }\nit('свой', () => { run(); });\n" },
      {
        path: 'tests/x.test.ts',
        text: [
          "import { it } from 'vitest';",
          "import { check as verifyTwo, Probe } from './support/check.ts';",
          "it('импорт под другим именем', () => { verifyTwo(2); });",
          "it('метод импортированного класса', () => { new Probe().verify(); });",
          'function run(): number { return 1; }',
          "it('тёзка чужого помощника', () => { run(); });",
        ].join('\n'),
      },
    ];
    const found = findVacuous(sources.filter((file) => file.path.endsWith('.test.ts')), assertingHelpers(sources));
    expect(found.noAssertions).toStrictEqual(['tests/x.test.ts:6 тёзка чужого помощника']);
  });

  it('репозиторий: тесты tests/ — холостых нет; намеренный провал — только у контроля консоли', () => {
    const files = walk('tests').filter((file) => !file.startsWith('tests/reference/'));
    const sources = files.filter((file) => /\.(test|spec)\.ts$/.test(file)).map(read);
    const helpers = assertingHelpers(files.map(read));
    expect(sources.length).toBeGreaterThan(100);
    expect(helpers.functions.size).toBeGreaterThan(10);
    const found = findVacuous(sources, helpers);
    expect({ ...found, expectedFailures: found.expectedFailures.map((entry) => entry.replace(/:\d+ /, ' ')) }).toStrictEqual({
      noAssertions: [],
      cannotFail: [],
      skipped: [],
      expectedFailures: ['tests/e2e/console.spec.ts фикстура консоли роняет тест, который оставил предупреждение'],
      unsizedScans: [],
    });
  });
});
