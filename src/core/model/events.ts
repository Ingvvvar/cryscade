// События раунда §4.8. Их видят все модули, генератор — только сервер и инструменты.
// Простые данные: переживают postMessage, IndexedDB и JSON.
//
// Грамматика:
//   раунд = спин [ scatters fsStart { fsSpin спин [ scatters fsRetrigger ] } ] end
//   спин  = fill { win explode spots refill }
//   кап обрывает раунд: win, на котором сумма дошла до капа, идёт как  win cap end

export interface WinCluster {
  readonly symbol: number;
  /** По возрастанию. */
  readonly cells: readonly number[];
  /** После множителя: таблица × mult, в тех же единицах, что end. */
  readonly payX100: number;
  /** Сумма множителей клеток по уровням до взрыва; 1 — если их нет. */
  readonly mult: number;
}

export type CellMove = readonly [from: number, to: number];

export interface CellDrop {
  readonly cell: number;
  readonly symbol: number;
}

export type RoundEvent =
  /** 49 символов нового спина. */
  | { readonly t: 'fill'; readonly grid: readonly number[] }
  /** Кластеры шага по наименьшей клетке. */
  | { readonly t: 'win'; readonly clusters: readonly WinCluster[] }
  /** Объединение клеток кластеров предыдущего win, по возрастанию. На шаге капа его нет. */
  | { readonly t: 'explode'; readonly cells: readonly number[] }
  /** Клетки, чей уровень изменился, и новые уровни в кодировке §4.7. Идёт после каждого explode, может быть пуст. */
  | { readonly t: 'spots'; readonly cells: readonly number[]; readonly levels: readonly number[] }
  /** moves — сдвинувшиеся символы по колонкам слева направо, в колонке снизу вверх; drops — по возрастанию клетки. */
  | { readonly t: 'refill'; readonly moves: readonly CellMove[]; readonly drops: readonly CellDrop[] }
  /** Ядра на сетке по возрастанию; только когда их ≥ 3, следом fsStart или fsRetrigger. */
  | { readonly t: 'scatters'; readonly cells: readonly number[] }
  /** Фича началась, поле точек чистое. */
  | { readonly t: 'fsStart'; readonly spins: number }
  /** index — с 1; left — сколько спинов останется после этого, без будущих ретриггеров. */
  | { readonly t: 'fsSpin'; readonly index: number; readonly left: number }
  | { readonly t: 'fsRetrigger'; readonly add: number }
  /** Сразу после win, на котором сумма раунда дошла до капа; следом end. */
  | { readonly t: 'cap' }
  /** min(кап, Σ payX100 всех кластеров всех win). */
  | { readonly t: 'end'; readonly payX100: number };

export type RoundEventType = RoundEvent['t'];
