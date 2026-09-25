import type { CellsView } from './views.ts';

/** Список клеток в предвыделенном буфере: очистка и добавление без аллокаций. */
export class CellList implements CellsView {
  readonly #cells: Uint8Array;
  #count = 0;

  constructor(capacity: number) {
    this.#cells = new Uint8Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  cellAt(index: number): number {
    return this.#cells[index] ?? 0;
  }

  clear(): void {
    this.#count = 0;
  }

  push(cell: number): void {
    if (this.#count >= this.#cells.length) {
      throw new RangeError(`CellList: ёмкость ${String(this.#cells.length)} исчерпана`);
    }
    this.#cells[this.#count] = cell;
    this.#count += 1;
  }
}
