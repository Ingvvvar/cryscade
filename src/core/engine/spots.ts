import { CELL_COUNT, SPOT_MAX_LEVEL } from '../model/grid.ts';
import { CellList } from './cell-list.ts';
import type { CellsView, ClusterView, SpotsView } from './views.ts';

/**
 * Точки множителей §4.3 в кодировке §4.7: 0 — нет, 1 — отметка, k от 2 до 8 — ×2^(k−1).
 * Точка принадлежит клетке, а не символу: символы падают, точки остаются.
 */
export class SpotField implements SpotsView {
  readonly #levels = new Uint8Array(CELL_COUNT);
  readonly #changed = new CellList(CELL_COUNT);

  get count(): number {
    return this.#changed.count;
  }

  cellAt(index: number): number {
    return this.#changed.cellAt(index);
  }

  levelAt(index: number): number {
    return this.#levels[this.#changed.cellAt(index)] ?? 0;
  }

  levelOf(cell: number): number {
    return this.#levels[cell] ?? 0;
  }

  reset(): void {
    this.#levels.fill(0);
    this.#changed.clear();
  }

  /** Сумма множителей клеток кластера по текущим уровням; отметка множителем не считается. Нет множителей — ×1. */
  multiplier(clusters: ClusterView, cluster: number): number {
    const size = clusters.size(cluster);
    let sum = 0;
    for (let index = 0; index < size; index++) {
      const level = this.#levels[clusters.cellAt(cluster, index)] ?? 0;
      if (level >= 2) sum += 1 << (level - 1);
    }
    return sum === 0 ? 1 : sum;
  }

  /** Взрыв в клетке: нет → отметка → ×2 → … → ×128, дальше не растёт. Запоминает изменившиеся клетки. */
  bump(cells: CellsView): void {
    this.#changed.clear();
    for (let index = 0; index < cells.count; index++) {
      const cell = cells.cellAt(index);
      const level = this.#levels[cell] ?? 0;
      if (level < SPOT_MAX_LEVEL) {
        this.#levels[cell] = level + 1;
        this.#changed.push(cell);
      }
    }
  }
}
