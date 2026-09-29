import { describe, expect, it } from 'vitest';
import { BundleBudget, INITIAL_JS_BUDGET, gzipBytes, initialFiles, type BudgetChunk } from '../../../tools/bundle-budget.ts';

// Бюджет начального JS (§13) на синтетическом графе: что считается начальным, что ленивым, воркер в счёте, отказ
// сверх бюджета. Настоящую сборку и положительный контроль (ленивый корень, импортированный статически) проверяет
// tests/e2e/bundle.spec.ts.

const chunk = (fileName: string, code: string, imports: readonly string[] = [], isEntry = false): BudgetChunk => ({ fileName, code, imports, isEntry });
const graph = (...chunks: BudgetChunk[]): Map<string, BudgetChunk> => new Map(chunks.map((item) => [item.fileName, item]));

describe('initialFiles', () => {
  it('вход и статические импорты по цепочке, общий чанк — один раз; динамический импорт — не начальный', () => {
    const chunks = graph(
      chunk('index.js', 'a', ['vendor.js', 'shared.js'], true),
      chunk('vendor.js', 'b', ['shared.js']),
      chunk('shared.js', 'c'),
      chunk('lazy.js', 'd', ['shared.js']),
    );
    expect(initialFiles(chunks)).toStrictEqual(['index.js', 'shared.js', 'vendor.js']);
  });

  it('входов нет — начального нет', () => {
    expect(initialFiles(graph(chunk('lazy.js', 'x')))).toStrictEqual([]);
  });
});

describe('BundleBudget', () => {
  it('бюджет — 300 КБ gzip', () => {
    expect(INITIAL_JS_BUDGET).toBe(307_200);
  });

  it('итог — страница плюс воркеры; ленивое не в счёте', () => {
    const budget = new BundleBudget(10_000);
    budget.recordWorker(graph(chunk('worker.js', 'w'.repeat(500), [], true), chunk('worker-lazy.js', 'z'.repeat(9000))));
    const report = budget.check(graph(chunk('index.js', 'i'.repeat(700), [], true), chunk('lazy.js', 'l'.repeat(9000))));
    const main = gzipBytes('i'.repeat(700));
    const workers = gzipBytes('w'.repeat(500));
    expect(report).toStrictEqual({ limit: 10_000, main, workers, total: main + workers, files: ['index.js', 'worker.js'] });
  });

  it('ленивый корень, импортированный статически, выводит за бюджет — отказ с разбивкой', () => {
    const lazyCode = Array.from({ length: 4000 }, (_, i) => String(i * 7919)).join(';');
    const lazy = graph(chunk('index.js', 'i', [], true), chunk('lazy.js', lazyCode));
    const eager = graph(chunk('index.js', 'i', ['lazy.js'], true), chunk('lazy.js', lazyCode));
    const limit = gzipBytes('i') + 100;
    expect(new BundleBudget(limit).check(lazy).total).toBe(gzipBytes('i'));
    expect(() => new BundleBudget(limit).check(eager)).toThrow(/больше бюджета .*lazy\.js/);
  });

  it('ровно на бюджете — годится', () => {
    const chunks = graph(chunk('index.js', 'abc', [], true));
    expect(new BundleBudget(gzipBytes('abc')).check(chunks).total).toBe(gzipBytes('abc'));
  });
});
