import { CELL_COUNT, GRID_SIDE } from '../model/grid.ts';
import { SCATTER } from '../model/symbols.ts';
import type { ClusterView, GridView } from './views.ts';

/** Кластеры шага: геометрия от ClusterFinder, множитель и выплата — от движка. */
export class ClusterTable implements ClusterView {
  readonly #symbol = new Uint8Array(CELL_COUNT);
  readonly #start = new Uint8Array(CELL_COUNT);
  readonly #size = new Uint8Array(CELL_COUNT);
  readonly #cells = new Uint8Array(CELL_COUNT);
  // Множитель — до 49 × 128, выплата — таблица × множитель: шире u16 и u32 соответственно.
  readonly #mult = new Uint16Array(CELL_COUNT);
  readonly #payX100 = new Float64Array(CELL_COUNT);
  #count = 0;
  #cellCount = 0;

  get count(): number {
    return this.#count;
  }

  symbol(cluster: number): number {
    return this.#symbol[cluster] ?? 0;
  }

  size(cluster: number): number {
    return this.#size[cluster] ?? 0;
  }

  cellAt(cluster: number, index: number): number {
    return this.#cells[(this.#start[cluster] ?? 0) + index] ?? 0;
  }

  mult(cluster: number): number {
    return this.#mult[cluster] ?? 0;
  }

  payX100(cluster: number): number {
    return this.#payX100[cluster] ?? 0;
  }

  clear(): void {
    this.#count = 0;
    this.#cellCount = 0;
  }

  /** Кластеры не пересекаются, поэтому клеток всех кластеров шага не больше 49. */
  add(symbol: number, cells: Uint8Array, size: number): void {
    const cluster = this.#count;
    this.#symbol[cluster] = symbol;
    this.#start[cluster] = this.#cellCount;
    this.#size[cluster] = size;
    this.#mult[cluster] = 1;
    this.#payX100[cluster] = 0;
    for (let index = 0; index < size; index++) this.#cells[this.#cellCount + index] = cells[index] ?? 0;
    this.#cellCount += size;
    this.#count += 1;
  }

  price(cluster: number, mult: number, payX100: number): void {
    this.#mult[cluster] = mult;
    this.#payX100[cluster] = payX100;
  }
}

/**
 * Кластеры — связные по стороне (4 соседа) группы одного символа не меньше clusterMin. Ядро кластеров
 * не образует. Заливка с предвыделенным стеком; кластеры идут по наименьшей клетке, клетки — по возрастанию.
 */
export class ClusterFinder {
  readonly #clusterMin: number;
  readonly #visited = new Uint8Array(CELL_COUNT);
  readonly #stack = new Uint8Array(CELL_COUNT);
  readonly #component = new Uint8Array(CELL_COUNT);

  constructor(clusterMin: number) {
    if (!Number.isInteger(clusterMin) || clusterMin < 2 || clusterMin > CELL_COUNT) {
      throw new RangeError(`clusterMin: ожидается целое от 2 до ${String(CELL_COUNT)}, получено ${String(clusterMin)}`);
    }
    this.#clusterMin = clusterMin;
  }

  find(grid: GridView, out: ClusterTable): number {
    out.clear();
    this.#visited.fill(0);
    // Первая непосещённая клетка компоненты — её наименьшая клетка: кластеры выходят по возрастанию.
    for (let start = 0; start < CELL_COUNT; start++) {
      if (this.#visited[start] !== 0) continue;
      const symbol = grid.symbolAt(start);
      if (symbol === SCATTER) continue;
      const size = this.#flood(grid, start, symbol);
      if (size >= this.#clusterMin) {
        this.#sortComponent(size);
        out.add(symbol, this.#component, size);
      }
    }
    return out.count;
  }

  #flood(grid: GridView, start: number, symbol: number): number {
    this.#visited[start] = 1;
    this.#stack[0] = start;
    let top = 1;
    let size = 0;
    while (top > 0) {
      top -= 1;
      const cell = this.#stack[top] ?? 0;
      this.#component[size] = cell;
      size += 1;
      const col = cell % GRID_SIDE;
      if (cell >= GRID_SIDE) top = this.#visit(grid, cell - GRID_SIDE, symbol, top);
      if (cell < CELL_COUNT - GRID_SIDE) top = this.#visit(grid, cell + GRID_SIDE, symbol, top);
      if (col > 0) top = this.#visit(grid, cell - 1, symbol, top);
      if (col < GRID_SIDE - 1) top = this.#visit(grid, cell + 1, symbol, top);
    }
    return size;
  }

  #visit(grid: GridView, cell: number, symbol: number, top: number): number {
    if (this.#visited[cell] !== 0 || grid.symbolAt(cell) !== symbol) return top;
    this.#visited[cell] = 1;
    this.#stack[top] = cell;
    return top + 1;
  }

  /** Вставками: не больше 49 элементов, без аллокаций. */
  #sortComponent(size: number): void {
    const cells = this.#component;
    for (let i = 1; i < size; i++) {
      const cell = cells[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && (cells[j] ?? 0) > cell) {
        cells[j + 1] = cells[j] ?? 0;
        j -= 1;
      }
      cells[j + 1] = cell;
    }
  }
}
