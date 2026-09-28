import type { RoundEvent } from '../model/events.ts';
import { CELL_COUNT } from '../model/grid.ts';

const EMPTY = -1;

/**
 * Итоговая сетка раунда — что лежит на поле, когда раунд показан до конца: сетка последнего спина после его последнего
 * шага. На капе кластеры не взрываются, сетка полная. Вход — события, прошедшие гард протокола: по ним сетка
 * восстанавливается на каждом шаге. Если нет — это ошибка вызывающего, а не данных, и она бросается.
 */
export function finalGrid(events: readonly RoundEvent[]): number[] {
  const grid = new Array<number>(CELL_COUNT).fill(EMPTY);
  for (const event of events) {
    switch (event.t) {
      case 'fill':
        for (let cell = 0; cell < CELL_COUNT; cell++) grid[cell] = event.grid[cell] ?? EMPTY;
        break;
      case 'explode':
        for (const cell of event.cells) grid[cell] = EMPTY;
        break;
      case 'refill':
        for (const [from, to] of event.moves) {
          grid[to] = grid[from] ?? EMPTY;
          grid[from] = EMPTY;
        }
        for (const drop of event.drops) grid[drop.cell] = drop.symbol;
        break;
      default:
        break;
    }
  }
  if (grid.includes(EMPTY)) throw new RangeError('finalGrid: по событиям не собирается полная сетка — сначала гард протокола');
  return grid;
}
