import { describe, expect, it } from 'vitest';
import { BundleBudget, INITIAL_JS_BUDGET, LAZY_MODULES, gzipBytes, initialFiles, type BudgetChunk } from '../../../tools/bundle-budget.ts';

// Бюджет начального JS (§13) на синтетическом графе: что считается начальным, что ленивым, воркер в счёте, отказ
// сверх бюджета, отказ на ленивом модуле в начальном JS при любом размере, порог — безопасное целое больше нуля.
// Настоящую сборку и положительные контроли (зонд статически при реальном пороге, порог без переменной) проверяет
// tests/e2e/bundle.spec.ts.

const chunk = (fileName: string, code: string, imports: readonly string[] = [], isEntry = false, modules: readonly string[] = []): BudgetChunk => ({
  fileName,
  code,
  imports,
  isEntry,
  modules,
});
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

  it.each([Number.NaN, 0, -1, 1.5, 2 ** 53, Number.POSITIVE_INFINITY])('порог %s — не безопасное целое больше нуля: отказ с понятным сообщением', (limit) => {
    expect(() => new BundleBudget(limit)).toThrow(`бюджет начального JS — безопасное целое больше нуля, байт gzip; получено ${String(limit)}`);
  });

  it('порог 1 — годится', () => {
    expect(new BundleBudget(1).check(graph()).total).toBe(0);
  });
});

describe('ленивый модуль в начальном JS (§13)', () => {
  const PROBE = '/Users/someone/cryscade/src/ui/probe.ts';

  it('список — зонд страницы, английский словарь и диалоги', () => {
    expect(LAZY_MODULES).toStrictEqual([
      'src/ui/probe.ts',
      'src/ui/i18n/en.ts',
      'src/ui/dialogs/settings-dialog.tsx',
      'src/ui/dialogs/rules-dialog.tsx',
      'src/ui/dialogs/history-dialog.tsx',
      'src/ui/dialogs/fairness-dialog.tsx',
    ]);
  });

  it('в статическом замыкании входа — отказ при любом размере, с модулем и файлом', () => {
    const chunks = graph(chunk('index.js', 'i', ['shared.js'], true, ['/p/src/ui/main.tsx']), chunk('shared.js', 's', [], false, [PROBE]));
    expect(() => new BundleBudget(Number.MAX_SAFE_INTEGER).check(chunks)).toThrow('ленивый модуль в начальном JS — его место за динамическим импортом (§13): src/ui/probe.ts в shared.js');
  });

  it('в ленивом чанке — годится', () => {
    const chunks = graph(chunk('index.js', 'i', [], true, ['/p/src/ui/main.tsx']), chunk('probe.js', 'p', [], false, [PROBE]));
    expect(new BundleBudget().check(chunks).files).toStrictEqual(['index.js']);
  });

  it('в начальном JS воркера — отказ уже на сборке воркера', () => {
    const budget = new BundleBudget();
    expect(() => {
      budget.recordWorker(graph(chunk('worker.js', 'w', [], true, [`${PROBE}?worker_file&type=module`])));
    }).toThrow('src/ui/probe.ts в worker.js');
  });

  it('узнаётся конец пути целиком: чужой probe.ts и тот же путь без каталога — мимо', () => {
    const chunks = graph(chunk('index.js', 'i', [], true, ['/p/src/render/pixi/probe.ts', '/p/src/ui/my-probe.ts', 'src/ui/probe.ts']));
    expect(new BundleBudget().check(chunks).files).toStrictEqual(['index.js']);
  });
});
