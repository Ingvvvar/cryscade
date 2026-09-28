import type { RoundEvent, WinCluster } from '../core/model/events.ts';
import { CELL_COUNT, GRID_SIDE, SPOT_MAX_LEVEL } from '../core/model/grid.ts';
import { PAYING_SYMBOL_COUNT, SCATTER, SYMBOL_COUNT } from '../core/model/symbols.ts';
import { isAscendingInts, isIntIn, isNat, isPositive, isRecord } from './guards.ts';

// Гард событий раунда §4.8 в три слоя:
// 1. строение — у каждого события свои поля, числа в своих границах, клетки по возрастанию;
// 2. грамматика — порядок событий, счётчики фриспинов, итог end против суммы кластеров;
// 3. сквозная сверка сетки — после каждого шага по событиям восстанавливается полная сетка: кластер стоит на своём
//    символе, взрыв — ровно его клетки, сдвиг идёт вниз в пустую клетку, досыпка закрывает ровно пустые, ядра — все.
// Гард не пересчитывает кластеры и выплаты — для этого нужен конфиг, это делает движок. Он гарантирует другое: по
// прошедшим событиям презентация восстановит любой момент и не упадёт.

const LAST_CELL = CELL_COUNT - 1;
const LAST_SYMBOL = SYMBOL_COUNT - 1;
const LAST_PAYING = PAYING_SYMBOL_COUNT - 1;
const EMPTY = -1;

/** Сетка: 49 символов от 0 до 7. */
export function isSymbolGrid(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length !== CELL_COUNT) return false;
  const cells: readonly unknown[] = value;
  return cells.every((symbol) => isIntIn(symbol, 0, LAST_SYMBOL));
}

function clusterProblem(cluster: unknown): string | null {
  if (!isRecord(cluster)) return 'кластер — не объект';
  if (!isIntIn(cluster['symbol'], 0, LAST_PAYING)) return 'symbol кластера — не платящий символ';
  const cells = cluster['cells'];
  if (!isAscendingInts(cells, 0, LAST_CELL) || cells.length === 0) return 'клетки кластера — не клетки по возрастанию';
  const payX100 = cluster['payX100'];
  const mult = cluster['mult'];
  if (!isNat(payX100) || !isPositive(mult)) return 'payX100 или mult кластера — не целые';
  if (payX100 % mult !== 0) return 'payX100 кластера не делится на mult';
  return null;
}

function refillProblem(event: Readonly<Record<string, unknown>>): string | null {
  const moves = event['moves'];
  const drops = event['drops'];
  if (!Array.isArray(moves) || !Array.isArray(drops)) return 'refill без moves или drops';
  const moveList: readonly unknown[] = moves;
  for (const move of moveList) {
    if (!Array.isArray(move) || move.length !== 2) return 'сдвиг — не пара клеток';
    const pair: readonly unknown[] = move;
    if (!pair.every((cell) => isIntIn(cell, 0, LAST_CELL))) return 'сдвиг — не пара клеток';
  }
  let previous = -1;
  const dropList: readonly unknown[] = drops;
  for (const drop of dropList) {
    if (!isRecord(drop)) return 'досыпка — не объект';
    const cell = drop['cell'];
    if (!isIntIn(cell, 0, LAST_CELL) || !isIntIn(drop['symbol'], 0, LAST_SYMBOL)) return 'досыпка — не клетка с символом';
    if (cell <= previous) return 'досыпка не по возрастанию клетки';
    previous = cell;
  }
  return null;
}

/** Строение одного события; null — годится. */
function shapeProblem(event: unknown): string | null {
  if (!isRecord(event)) return 'событие — не объект';
  switch (event['t']) {
    case 'fill':
      return isSymbolGrid(event['grid']) ? null : 'fill: нужны 49 символов';
    case 'win': {
      const clusters = event['clusters'];
      if (!Array.isArray(clusters) || clusters.length === 0) return 'win без кластеров';
      const list: readonly unknown[] = clusters;
      for (const cluster of list) {
        const problem = clusterProblem(cluster);
        if (problem !== null) return `win: ${problem}`;
      }
      return null;
    }
    case 'explode':
      return isAscendingInts(event['cells'], 0, LAST_CELL) ? null : 'explode: клетки не по возрастанию';
    case 'spots': {
      const cells = event['cells'];
      const levels = event['levels'];
      if (!isAscendingInts(cells, 0, LAST_CELL) || !Array.isArray(levels) || levels.length !== cells.length) {
        return 'spots: клетки и уровни не парами';
      }
      const levelList: readonly unknown[] = levels;
      return levelList.every((level) => isIntIn(level, 1, SPOT_MAX_LEVEL)) ? null : 'spots: уровень вне 1…8';
    }
    case 'refill':
      return refillProblem(event);
    case 'scatters': {
      const cells = event['cells'];
      return isAscendingInts(cells, 0, LAST_CELL) && cells.length > 0 ? null : 'scatters: клетки не по возрастанию';
    }
    case 'fsStart':
      return isPositive(event['spins']) ? null : 'fsStart: spins не положительное целое';
    case 'fsSpin':
      return isPositive(event['index']) && isNat(event['left']) ? null : 'fsSpin: index или left не целые';
    case 'fsRetrigger':
      return isPositive(event['add']) ? null : 'fsRetrigger: add не положительное целое';
    case 'cap':
      return null;
    case 'end':
      return isNat(event['payX100']) ? null : 'end: payX100 не целое';
    default:
      return 'неизвестный тип события';
  }
}

type Expect = 'fill' | 'grid' | 'won' | 'exploded' | 'spotted' | 'capped' | 'scattered' | 'feature' | 'done';

/**
 * Грамматика и сетка: автомат по событиям, прошедшим проверку строения. Сетка — 49 клеток, пустая — −1.
 *   раунд = спин [ scatters fsStart { fsSpin спин [ scatters fsRetrigger ] } ] end
 *   спин  = fill { win explode spots refill },  кап: win cap end
 */
class RoundGrammar {
  readonly #grid = new Array<number>(CELL_COUNT).fill(EMPTY);
  /** Клетки последнего win: explode обязан совпасть с ними, spots — лежать внутри. */
  readonly #won = new Array<boolean>(CELL_COUNT).fill(false);
  #expect: Expect = 'fill';
  #inFeature = false;
  #spins = 0;
  #left = 0;
  #totalX100 = 0;
  #capped = false;

  step(event: RoundEvent): string | null {
    if (this.#expect === 'done') return 'событие после end';
    switch (event.t) {
      case 'fill':
        if (this.#expect !== 'fill') return 'fill не на месте';
        for (let cell = 0; cell < CELL_COUNT; cell++) this.#grid[cell] = event.grid[cell] ?? EMPTY;
        this.#expect = 'grid';
        return null;
      case 'win':
        return this.#expect === 'grid' ? this.#win(event.clusters) : 'win не после сетки';
      case 'explode':
        return this.#expect === 'won' ? this.#explode(event.cells) : 'explode не после win';
      case 'spots':
        if (this.#expect !== 'exploded') return 'spots не после explode';
        if (!event.cells.every((cell) => this.#won[cell])) return 'spots: клетка вне взрыва';
        this.#expect = 'spotted';
        return null;
      case 'refill':
        return this.#expect === 'spotted' ? this.#refill(event.moves, event.drops) : 'refill не после spots';
      case 'cap':
        if (this.#expect !== 'won') return 'cap не сразу после win';
        this.#capped = true;
        this.#expect = 'capped';
        return null;
      case 'scatters':
        return this.#expect === 'grid' ? this.#scatters(event.cells) : 'scatters не после сетки';
      case 'fsStart':
        if (this.#expect !== 'scattered' || this.#inFeature) return 'fsStart не после scatters основной игры';
        this.#inFeature = true;
        this.#left = event.spins;
        this.#expect = 'feature';
        return null;
      case 'fsRetrigger':
        if (this.#expect !== 'scattered' || !this.#inFeature) return 'fsRetrigger не после scatters фриспина';
        this.#left += event.add;
        if (!Number.isSafeInteger(this.#left)) return 'fsRetrigger: счёт спинов вне целых';
        this.#expect = 'feature';
        return null;
      case 'fsSpin':
        return this.#spin(event.index, event.left);
      case 'end':
        return this.#end(event.payX100);
    }
  }

  finish(): string | null {
    return this.#expect === 'done' ? null : 'раунд без end';
  }

  #win(clusters: readonly WinCluster[]): string | null {
    this.#won.fill(false);
    let previousFirst = -1;
    for (const cluster of clusters) {
      const first = cluster.cells[0] ?? -1;
      if (first <= previousFirst) return 'win: кластеры не по наименьшей клетке';
      previousFirst = first;
      for (const cell of cluster.cells) {
        if (this.#won[cell] === true) return 'win: кластеры пересекаются';
        if (this.#grid[cell] !== cluster.symbol) return 'win: в клетке кластера другой символ';
        this.#won[cell] = true;
      }
      this.#totalX100 += cluster.payX100;
    }
    if (!Number.isSafeInteger(this.#totalX100)) return 'win: сумма выплат вне целых';
    this.#expect = 'won';
    return null;
  }

  #explode(cells: readonly number[]): string | null {
    let count = 0;
    for (const cell of cells) {
      if (this.#won[cell] !== true) return 'explode: клетка вне кластеров win';
      this.#grid[cell] = EMPTY;
      count += 1;
    }
    if (count !== this.#won.filter(Boolean).length) return 'explode: не все клетки кластеров';
    this.#expect = 'exploded';
    return null;
  }

  #refill(moves: readonly (readonly [number, number])[], drops: readonly { cell: number; symbol: number }[]): string | null {
    const grid = this.#grid;
    let column = -1;
    let lowest = CELL_COUNT;
    for (const [from, to] of moves) {
      const own = from % GRID_SIDE;
      if (to % GRID_SIDE !== own || to <= from) return 'refill: сдвиг не вниз по своей колонке';
      if (own < column) return 'refill: колонки не слева направо';
      if (own > column) lowest = CELL_COUNT;
      if (to >= lowest) return 'refill: в колонке сдвиги не снизу вверх';
      column = own;
      lowest = to;
      const symbol = grid[from] ?? EMPTY;
      if (symbol === EMPTY || grid[to] !== EMPTY) return 'refill: сдвиг из пустой клетки или в занятую';
      grid[to] = symbol;
      grid[from] = EMPTY;
    }
    let next = 0;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (grid[cell] !== EMPTY) continue;
      const drop = drops[next];
      if (drop?.cell !== cell) return 'refill: досыпка не ровно в пустые клетки';
      grid[cell] = drop.symbol;
      next += 1;
    }
    if (next !== drops.length) return 'refill: досыпка в занятую клетку';
    this.#expect = 'grid';
    return null;
  }

  #scatters(cells: readonly number[]): string | null {
    const cores = this.#grid.flatMap((symbol, cell) => (symbol === SCATTER ? [cell] : []));
    if (cores.length !== cells.length || cores.some((cell, index) => cells[index] !== cell)) {
      return 'scatters: не все ядра сетки';
    }
    this.#expect = 'scattered';
    return null;
  }

  #spin(index: number, left: number): string | null {
    const between = this.#expect === 'feature' || (this.#expect === 'grid' && this.#inFeature);
    if (!between || this.#left === 0) return 'fsSpin не на месте';
    if (index !== this.#spins + 1 || left !== this.#left - 1) return 'fsSpin: номер или остаток не по счёту';
    this.#spins = index;
    this.#left = left;
    this.#expect = 'fill';
    return null;
  }

  #end(payX100: number): string | null {
    const settled = this.#expect === 'capped' || (this.#expect === 'grid' && (!this.#inFeature || this.#left === 0));
    if (!settled) return 'end не на месте';
    if (this.#capped ? payX100 > this.#totalX100 : payX100 !== this.#totalX100) {
      return 'end: payX100 не сходится с суммой кластеров';
    }
    this.#expect = 'done';
    return null;
  }
}

/** Первая проблема событий раунда с номером события или null — события годятся. Не бросает. */
export function checkRoundEvents(events: unknown): string | null {
  if (!Array.isArray(events) || events.length === 0) return 'события — не непустой массив';
  const list: readonly unknown[] = events;
  const grammar = new RoundGrammar();
  for (let index = 0; index < list.length; index++) {
    const event = list[index];
    const problem = shapeProblem(event) ?? grammar.step(event as RoundEvent);
    if (problem !== null) return `событие ${String(index)}: ${problem}`;
  }
  return grammar.finish();
}

export function isRoundEvents(events: unknown): events is readonly RoundEvent[] {
  return checkRoundEvents(events) === null;
}
