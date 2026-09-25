import type { CellDrop, CellMove, RoundEvent, WinCluster } from '../model/events.ts';
import { CELL_COUNT } from '../model/grid.ts';
import type { RoundRecorder } from './recorder.ts';
import type { CellsView, ClusterView, GridView, RefillView, SpotsView } from './views.ts';

/**
 * Записывающий режим — события для сервера и повторов. Копирует виды в простые данные: они переживают
 * postMessage, IndexedDB и JSON. Не горячий путь: один раунд на запрос, аллокации задаёт формат событий.
 */
export class EventRecorder implements RoundRecorder {
  #events: RoundEvent[] = [];

  /** События последнего раунда. Следующий раунд начинает новый массив — прежний не меняется. */
  get events(): readonly RoundEvent[] {
    return this.#events;
  }

  begin(): void {
    this.#events = [];
  }

  fill(grid: GridView): void {
    const cells: number[] = [];
    for (let cell = 0; cell < CELL_COUNT; cell++) cells.push(grid.symbolAt(cell));
    this.#events.push({ t: 'fill', grid: cells });
  }

  win(clusters: ClusterView): void {
    const list: WinCluster[] = [];
    for (let cluster = 0; cluster < clusters.count; cluster++) {
      const cells: number[] = [];
      for (let index = 0; index < clusters.size(cluster); index++) cells.push(clusters.cellAt(cluster, index));
      list.push({ symbol: clusters.symbol(cluster), cells, payX100: clusters.payX100(cluster), mult: clusters.mult(cluster) });
    }
    this.#events.push({ t: 'win', clusters: list });
  }

  explode(cells: CellsView): void {
    this.#events.push({ t: 'explode', cells: listOf(cells) });
  }

  spots(spots: SpotsView): void {
    const cells: number[] = [];
    const levels: number[] = [];
    for (let index = 0; index < spots.count; index++) {
      cells.push(spots.cellAt(index));
      levels.push(spots.levelAt(index));
    }
    this.#events.push({ t: 'spots', cells, levels });
  }

  refill(refill: RefillView): void {
    const moves: CellMove[] = [];
    for (let index = 0; index < refill.moveCount; index++) moves.push([refill.moveFrom(index), refill.moveTo(index)]);
    const drops: CellDrop[] = [];
    for (let index = 0; index < refill.dropCount; index++) {
      drops.push({ cell: refill.dropCell(index), symbol: refill.dropSymbol(index) });
    }
    this.#events.push({ t: 'refill', moves, drops });
  }

  scatters(cells: CellsView): void {
    this.#events.push({ t: 'scatters', cells: listOf(cells) });
  }

  fsStart(spins: number): void {
    this.#events.push({ t: 'fsStart', spins });
  }

  fsSpin(index: number, left: number): void {
    this.#events.push({ t: 'fsSpin', index, left });
  }

  fsRetrigger(add: number): void {
    this.#events.push({ t: 'fsRetrigger', add });
  }

  cap(): void {
    this.#events.push({ t: 'cap' });
  }

  end(payX100: number): void {
    this.#events.push({ t: 'end', payX100 });
  }
}

function listOf(cells: CellsView): number[] {
  const list: number[] = [];
  for (let index = 0; index < cells.count; index++) list.push(cells.cellAt(index));
  return list;
}
