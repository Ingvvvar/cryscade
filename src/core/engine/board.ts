import type { SpinMode } from '../model/config.ts';
import { CELL_COUNT, GRID_SIDE } from '../model/grid.ts';
import { SCATTER, SYMBOL_COUNT } from '../model/symbols.ts';
import { CellList } from './cell-list.ts';
import type { SymbolSource } from './source.ts';
import type { CellsView, ClusterView, GridView, RefillView } from './views.ts';

/** Сетка 7×7: заполнение, взрыв, падение и досыпка. Всё — в предвыделенных буферах. */
export class Board implements GridView, RefillView {
  readonly #grid = new Uint8Array(CELL_COUNT);
  readonly #exploded = new Uint8Array(CELL_COUNT);
  readonly #explodedCells = new CellList(CELL_COUNT);
  readonly #scatterCells = new CellList(CELL_COUNT);
  readonly #moveFrom = new Uint8Array(CELL_COUNT);
  readonly #moveTo = new Uint8Array(CELL_COUNT);
  readonly #dropCells = new Uint8Array(CELL_COUNT);
  readonly #dropSymbols = new Uint8Array(CELL_COUNT);
  /** Сколько клеток сверху в колонке опустело после падения. */
  readonly #emptyTop = new Uint8Array(GRID_SIDE);
  #moveCount = 0;
  #dropCount = 0;

  symbolAt(cell: number): number {
    return this.#grid[cell] ?? 0;
  }

  /** Клетки последнего взрыва по возрастанию. */
  get exploded(): CellsView {
    return this.#explodedCells;
  }

  get moveCount(): number {
    return this.#moveCount;
  }

  moveFrom(index: number): number {
    return this.#moveFrom[index] ?? 0;
  }

  moveTo(index: number): number {
    return this.#moveTo[index] ?? 0;
  }

  get dropCount(): number {
    return this.#dropCount;
  }

  dropCell(index: number): number {
    return this.#dropCells[index] ?? 0;
  }

  dropSymbol(index: number): number {
    return this.#dropSymbols[index] ?? 0;
  }

  /** Новая сетка спина: клетки 0…48 по порядку. */
  fill(source: SymbolSource, mode: SpinMode): void {
    this.#exploded.fill(0);
    this.#explodedCells.clear();
    this.#moveCount = 0;
    this.#dropCount = 0;
    for (let cell = 0; cell < CELL_COUNT; cell++) this.#grid[cell] = draw(source, mode, cell);
  }

  /** Все клетки всех кластеров шага взрываются разом. */
  explode(clusters: ClusterView): void {
    for (let cluster = 0; cluster < clusters.count; cluster++) {
      const size = clusters.size(cluster);
      for (let index = 0; index < size; index++) this.#exploded[clusters.cellAt(cluster, index)] = 1;
    }
    this.#explodedCells.clear();
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (this.#exploded[cell] !== 0) this.#explodedCells.push(cell);
    }
  }

  /**
   * Уцелевшие символы, ядра тоже, падают вниз без зазоров: по колонкам слева направо, в колонке снизу вверх.
   * Потом источник досыпает пустые клетки по возрастанию номера.
   */
  collapse(source: SymbolSource, mode: SpinMode): void {
    this.#moveCount = 0;
    for (let col = 0; col < GRID_SIDE; col++) {
      let write = GRID_SIDE - 1;
      for (let row = GRID_SIDE - 1; row >= 0; row--) {
        const cell = row * GRID_SIDE + col;
        if (this.#exploded[cell] !== 0) continue;
        if (row !== write) {
          const to = write * GRID_SIDE + col;
          this.#grid[to] = this.#grid[cell] ?? 0;
          this.#moveFrom[this.#moveCount] = cell;
          this.#moveTo[this.#moveCount] = to;
          this.#moveCount += 1;
        }
        write -= 1;
      }
      this.#emptyTop[col] = write + 1;
    }
    this.#exploded.fill(0);

    this.#dropCount = 0;
    for (let row = 0; row < GRID_SIDE; row++) {
      for (let col = 0; col < GRID_SIDE; col++) {
        if (row >= (this.#emptyTop[col] ?? 0)) continue;
        const cell = row * GRID_SIDE + col;
        const symbol = draw(source, mode, cell);
        this.#grid[cell] = symbol;
        this.#dropCells[this.#dropCount] = cell;
        this.#dropSymbols[this.#dropCount] = symbol;
        this.#dropCount += 1;
      }
    }
  }

  /** Ядра на сетке по возрастанию. */
  collectScatters(): CellsView {
    this.#scatterCells.clear();
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (this.#grid[cell] === SCATTER) this.#scatterCells.push(cell);
    }
    return this.#scatterCells;
  }
}

function draw(source: SymbolSource, mode: SpinMode, cell: number): number {
  const symbol = source.next(mode, cell);
  if (!Number.isInteger(symbol) || symbol < 0 || symbol >= SYMBOL_COUNT) {
    throw new RangeError(`источник вернул не символ для клетки ${String(cell)}: ${String(symbol)}`);
  }
  return symbol;
}
