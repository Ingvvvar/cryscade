import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findDeadCode, scriptEntries, type Source } from './dead-code.ts';

// Мёртвый код (фаза 9, аудит): от точек входа — главный поток, воркер, скрипты package.json, конфиги — достижим каждый
// файл src/ и tools/, и у каждого экспорта есть импортёр (код, инструмент или тест). Сначала контроль: подброшенный
// неиспользуемый экспорт и файл вне графа находятся.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CODE = /\.(ts|tsx|mts|js|mjs)$/;
const CONFIGS = ['vite.config.ts', 'vite.budget-control.config.ts', 'vitest.config.ts', 'vitest.mutation.config.ts', 'playwright.config.ts', 'playwright.gpu.config.ts', 'playwright.sound.config.ts', 'playwright.measure.config.ts', 'eslint.config.js'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.posix.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (CODE.test(entry)) out.push(rel);
  }
  return out;
}

/** Тексты, где названы скрипты: package.json, документация и сам код (скрипт запускает скрипт процессом). */
const MENTIONS = ['package.json', 'README.md', 'TASK.md', ...readdirSync(path.join(ROOT, 'docs')).filter((file) => file.endsWith('.md')).map((file) => `docs/${file}`)].filter(
  (file) => existsSync(path.join(ROOT, file)),
);

function repo(): { files: Source[]; entries: string[] } {
  const paths = [...walk('src'), ...walk('tools'), ...walk('tests'), ...walk('lint'), ...CONFIGS];
  const files = paths.map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), 'utf8') }));
  const texts = [...MENTIONS.map((file) => readFileSync(path.join(ROOT, file), 'utf8')), ...files.filter((file) => file.path.startsWith('tools/')).map((file) => file.text)];
  return { files, entries: ['src/ui/main.tsx', 'src/server/worker.ts', ...scriptEntries(texts), ...CONFIGS] };
}

describe('мёртвый код', () => {
  it('контроль: подброшенный неиспользуемый экспорт, бочка без импортёра и файл вне графа находятся', () => {
    const files: Source[] = [
      { path: 'src/a.ts', text: "export const used = 1;\nexport const unused = 2;\nexport function viaBarrel(): number { return 3; }\n" },
      { path: 'src/barrel.ts', text: "export { viaBarrel } from './a.ts';\nexport { unused as alsoUnused } from './a.ts';\n" },
      { path: 'src/main.ts', text: "import { used } from './a.ts';\nimport { viaBarrel } from './barrel.ts';\nconsole.log(used, viaBarrel());\n" },
      { path: 'src/orphan.ts', text: 'export const orphan = 4;\n' },
    ];
    const dead = findDeadCode(files, ['src/'], ['src/main.ts']);
    expect(dead.unreachable).toStrictEqual(['src/orphan.ts']);
    expect(dead.unusedExports).toStrictEqual(['src/a.ts:2 unused', 'src/barrel.ts:2 alsoUnused (реэкспорт)', 'src/orphan.ts:1 orphan']);
  });

  it('контроль: import * и import() — все экспорты модуля в деле; тип через import(\'…\').Имя — тоже', () => {
    const files: Source[] = [
      { path: 'src/a.ts', text: 'export const x = 1;\nexport const y = 2;\n' },
      { path: 'src/b.ts', text: 'export interface Shape { readonly n: number }\nexport const z = 3;\n' },
      { path: 'src/main.ts', text: "import * as a from './a.ts';\nconst lazy = (): Promise<unknown> => import('./b.ts');\nlet s: import('./b.ts').Shape | null = null;\nconsole.log(a, lazy, s);\n" },
    ];
    expect(findDeadCode(files, ['src/'], ['src/main.ts']).unusedExports).toStrictEqual([]);
  });

  it('контроль: import * бочки с export * — в деле экспорты модуля за бочкой', () => {
    const files: Source[] = [
      { path: 'src/a.ts', text: 'export const x = 1;\nexport const y = 2;\n' },
      { path: 'src/barrel.ts', text: "export * from './a.ts';\n" },
      { path: 'src/main.ts', text: "import * as all from './barrel.ts';\nconsole.log(all);\n" },
    ];
    expect(findDeadCode(files, ['src/'], ['src/main.ts']).unusedExports).toStrictEqual([]);
  });

  it('репозиторий: каждый файл src/ и tools/ достижим, у каждого экспорта есть импортёр', () => {
    const { files, entries } = repo();
    expect(files.length).toBeGreaterThan(300);
    expect(entries.length).toBeGreaterThan(10);
    expect(findDeadCode(files, ['src/', 'tools/'], entries)).toStrictEqual({ unreachable: [], unusedExports: [] });
  });
});
