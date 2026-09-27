// Первая сетка фикстуры для визуального среза (§15, фаза 3): до фазы 4 раундов от сервера нет.
// Данные приходят из JSON — проверяются, а не приводятся.

import { CELL_COUNT } from '../core/model/grid.ts';
import { SYMBOL_COUNT, type SymbolId } from '../core/model/symbols.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isSymbol = (value: unknown): value is SymbolId =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SYMBOL_COUNT;

/** Сетка первого события fill раунда; испорченные данные — ошибка. */
export function firstGrid(round: unknown): SymbolId[] {
  const events = isRecord(round) ? round['events'] : undefined;
  if (!Array.isArray(events)) throw new TypeError('фикстура: нет массива events');
  const fill: unknown = events[0];
  if (!isRecord(fill) || fill['t'] !== 'fill') throw new TypeError('фикстура: первое событие — не fill');
  const grid = fill['grid'];
  if (!Array.isArray(grid) || grid.length !== CELL_COUNT) throw new TypeError(`фикстура: в fill не ${String(CELL_COUNT)} клеток`);
  return grid.map((symbol: unknown, cell) => {
    if (!isSymbol(symbol)) throw new TypeError(`фикстура: клетка ${String(cell)} — не символ`);
    return symbol;
  });
}
