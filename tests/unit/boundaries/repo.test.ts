import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkEdge, extensionViolations, forbiddenReach, moduleOf, scanRepo, topModule } from './graph.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const scan = scanRepo(ROOT);

describe('граница §3 на настоящем репозитории', () => {
  it('в каждом модуле найден хотя бы один файл', () => {
    const counts = new Map<string, number>();
    for (const file of scan.files) {
      const id = moduleOf(file);
      if (id !== null) counts.set(topModule(id), (counts.get(topModule(id)) ?? 0) + 1);
    }
    for (const top of ['core', 'protocol', 'server', 'client', 'render', 'ui', 'audio', 'tools']) {
      expect(counts.get(top) ?? 0, top).toBeGreaterThan(0);
    }
  });

  it('рёбер между файлами больше нуля', () => {
    const edges = [...scan.graph.values()].reduce((sum, targets) => sum + targets.length, 0);
    expect(edges).toBeGreaterThan(0);
  });

  it('в src/ нет файлов вне модулей', () => {
    expect(scan.files.filter((file) => moduleOf(file) === null)).toEqual([]);
  });

  it('каждое прямое ребро разрешено таблицей', () => {
    const violations = [...scan.imports].flatMap(([file, refs]) =>
      refs.flatMap(({ target }) => checkEdge(file, target) ?? []),
    );
    expect(violations).toEqual([]);
  });

  it('из client/, render/, ui/, audio/ не достижимы core/engine, core/rng, server/', () => {
    expect(forbiddenReach(scan.graph)).toEqual([]);
  });

  it('в core/, protocol/, server/ относительные импорты — с .ts', () => {
    expect(extensionViolations(scan)).toEqual([]);
  });
});
