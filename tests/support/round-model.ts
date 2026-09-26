import { isDeepStrictEqual } from 'node:util';
import type { GameConfig } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';

// Эталонная модель раунда. Из событий берёт только случайный вход — сетки fill и символы drops.
// Всё остальное пересчитывает сама и сверяет: кластеры, выплаты, множители, уровни точек, взрыв,
// падение, клетки досыпки, ядра, фриспины, кап, итог, порядок событий.
// Написана независимо от движка и нарочно наивно: обход в ширину вместо заливки стеком, множители —
// числом взрывов в клетке вместо уровней, падение — сборкой колонки заново, массивы вместо буферов.

const SIDE = 7;
const CELLS = SIDE * SIDE;
const CORE = 7;
const SYMBOLS = 8;
const TOP_LEVEL = 8;

export interface RoundFacts {
  readonly payX100: number;
  readonly featured: boolean;
  readonly freeSpins: number;
  readonly retriggers: number;
  readonly capped: boolean;
  /** Самая длинная цепочка выигрышных шагов в одном спине. */
  readonly longestCascade: number;
  /** Наибольший уровень точки за раунд. */
  readonly topLevel: number;
  /** Наибольший множитель кластера за раунд; 0 — кластеров не было. */
  readonly maxClusterMult: number;
  /** Самая большая связная группа ядер на сетке за раунд. */
  readonly largestCoreGroup: number;
  /** Ядер на сетке в конце основного спина — и тогда, когда его оборвал кап. */
  readonly baseCores: number;
  readonly baseCapped: boolean;
}

export class ModelMismatch extends Error {
  override readonly name = 'ModelMismatch';
}

type Of<T extends RoundEvent['t']> = Extract<RoundEvent, { t: T }>;

interface Group {
  readonly symbol: number;
  readonly cells: number[];
}

/** Связные по стороне группы одного символа не меньше min, по наименьшей клетке. */
function groupsOf(grid: readonly number[], min: number, accept: (symbol: number) => boolean): Group[] {
  const seen = new Set<number>();
  const groups: Group[] = [];
  for (let start = 0; start < CELLS; start++) {
    const symbol = grid[start];
    if (symbol === undefined || !accept(symbol) || seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head] ?? 0;
      const row = Math.floor(cell / SIDE);
      const col = cell % SIDE;
      const around = [
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1],
      ] as const;
      for (const [r, c] of around) {
        if (r < 0 || r >= SIDE || c < 0 || c >= SIDE) continue;
        const next = r * SIDE + c;
        if (!seen.has(next) && grid[next] === symbol) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    if (queue.length >= min) groups.push({ symbol, cells: queue.toSorted((a, b) => a - b) });
  }
  return groups.toSorted((a, b) => (a.cells[0] ?? 0) - (b.cells[0] ?? 0));
}

/** Кластеры: ядро кластеров не образует. */
function clustersOf(grid: readonly number[], min: number): Group[] {
  return groupsOf(grid, min, (symbol) => symbol !== CORE);
}

function isSymbol(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < SYMBOLS;
}

class RoundModel {
  readonly #config: GameConfig;
  readonly #events: readonly RoundEvent[];
  #at = 0;
  #grid: number[] = [];
  /** Сколько раз взрывалась клетка с последнего сброса точек. */
  #hits: number[] = new Array<number>(CELLS).fill(0);
  #total = 0;
  #capped = false;
  #freeSpins = 0;
  #retriggers = 0;
  #longest = 0;
  #topLevel = 0;
  #maxClusterMult = 0;
  #largestCoreGroup = 0;

  constructor(config: GameConfig, events: readonly RoundEvent[]) {
    this.#config = config;
    this.#events = events;
  }

  run(): RoundFacts {
    let featured = false;
    const baseDone = this.#spin();
    const baseCores = this.#cores().length;
    if (baseDone) {
      const award = this.#award(this.#cores().length);
      if (award > 0) {
        featured = true;
        this.#expect(this.#take('scatters').cells, this.#cores(), 'scatters: ядра на сетке');
        this.#expect(this.#take('fsStart').spins, award, 'fsStart: награда по таблице');
        this.#hits = new Array<number>(CELLS).fill(0);
        let played = 0;
        let awarded = award;
        while (played < awarded) {
          played += 1;
          const spin = this.#take('fsSpin');
          this.#expect([spin.index, spin.left], [played, awarded - played], 'fsSpin: номер и остаток');
          this.#freeSpins += 1;
          if (!this.#spin()) break;
          const cores = this.#cores();
          if (cores.length >= this.#config.retrigger.min) {
            this.#expect(this.#take('scatters').cells, cores, 'scatters: ядра ретриггера');
            this.#expect(this.#take('fsRetrigger').add, this.#config.retrigger.add, 'fsRetrigger: +add');
            awarded += this.#config.retrigger.add;
            this.#retriggers += 1;
          }
        }
      }
    }
    this.#expect(this.#take('end').payX100, this.#total, 'end: итог раунда');
    if (this.#at !== this.#events.length) this.#fail(`после end ещё ${String(this.#events.length - this.#at)} событий`);
    return {
      payX100: this.#total,
      featured,
      freeSpins: this.#freeSpins,
      retriggers: this.#retriggers,
      capped: this.#capped,
      longestCascade: this.#longest,
      topLevel: this.#topLevel,
      maxClusterMult: this.#maxClusterMult,
      largestCoreGroup: this.#largestCoreGroup,
      baseCores,
      baseCapped: !baseDone,
    };
  }

  /** Спин с цепочкой каскадов. false — кап. */
  #spin(): boolean {
    const fill = this.#take('fill');
    if (fill.grid.length !== CELLS || !fill.grid.every(isSymbol)) this.#fail('fill: нужны 49 символов от 0 до 7');
    this.#grid = [...fill.grid];
    let steps = 0;
    for (;;) {
      this.#noteCoreGroups();
      const groups = clustersOf(this.#grid, this.#config.clusterMin);
      if (groups.length === 0) return true;
      steps += 1;
      this.#longest = Math.max(this.#longest, steps);

      const expected = groups.map(({ symbol, cells }) => {
        const mult = cells.reduce((sum, cell) => sum + this.#multiplierOf(cell), 0) || 1;
        return { symbol, cells, payX100: this.#tableX100(symbol, cells.length) * mult, mult };
      });
      this.#expect(this.#take('win').clusters, expected, 'win: кластеры, множители, выплаты');
      for (const cluster of expected) this.#maxClusterMult = Math.max(this.#maxClusterMult, cluster.mult);
      this.#total += expected.reduce((sum, cluster) => sum + cluster.payX100, 0);
      if (this.#total >= this.#config.capX100) {
        this.#total = this.#config.capX100;
        this.#capped = true;
        this.#take('cap');
        return false;
      }

      const exploded = groups.flatMap((group) => group.cells).toSorted((a, b) => a - b);
      this.#expect(this.#take('explode').cells, exploded, 'explode: объединение клеток кластеров');

      const changed = exploded.filter((cell) => (this.#hits[cell] ?? 0) < TOP_LEVEL);
      for (const cell of exploded) this.#hits[cell] = (this.#hits[cell] ?? 0) + 1;
      const levels = changed.map((cell) => Math.min(this.#hits[cell] ?? 0, TOP_LEVEL));
      this.#topLevel = Math.max(this.#topLevel, ...levels);
      const spots = this.#take('spots');
      this.#expect({ cells: spots.cells, levels: spots.levels }, { cells: changed, levels }, 'spots: изменившиеся уровни');

      this.#refill(new Set(exploded));
    }
  }

  #refill(exploded: ReadonlySet<number>): void {
    const next: (number | null)[] = new Array<number | null>(CELLS).fill(null);
    const moves: [number, number][] = [];
    for (let col = 0; col < SIDE; col++) {
      const survivors: number[] = [];
      for (let row = SIDE - 1; row >= 0; row--) {
        const cell = row * SIDE + col;
        if (!exploded.has(cell)) survivors.push(cell);
      }
      survivors.forEach((from, depth) => {
        const to = (SIDE - 1 - depth) * SIDE + col;
        next[to] = this.#grid[from] ?? null;
        if (from !== to) moves.push([from, to]);
      });
    }
    const empty = next.flatMap((symbol, cell) => (symbol === null ? [cell] : []));

    const refill = this.#take('refill');
    this.#expect(refill.moves, moves, 'refill: падение');
    this.#expect(
      refill.drops.map((drop) => drop.cell),
      empty,
      'refill: досыпка ровно в пустые клетки, по возрастанию',
    );
    for (const { cell, symbol } of refill.drops) {
      if (!isSymbol(symbol)) this.#fail(`refill: досыпан не символ ${String(symbol)}`);
      next[cell] = symbol;
    }
    if (next.some((symbol) => symbol === null)) this.#fail('refill: после досыпки сетка не полна');
    this.#grid = next.map((symbol) => symbol ?? -1);
  }

  #noteCoreGroups(): void {
    for (const group of groupsOf(this.#grid, 1, (symbol) => symbol === CORE)) {
      this.#largestCoreGroup = Math.max(this.#largestCoreGroup, group.cells.length);
    }
  }

  #multiplierOf(cell: number): number {
    const hits = this.#hits[cell] ?? 0;
    return hits >= 2 ? 2 ** (Math.min(hits, TOP_LEVEL) - 1) : 0;
  }

  #tableX100(symbol: number, size: number): number {
    let band = -1;
    this.#config.sizeBands.forEach((lower, index) => {
      if (size >= lower) band = index;
    });
    return this.#config.paytableX100[symbol]?.[band] ?? Number.NaN;
  }

  #award(cores: number): number {
    const table = this.#config.freeSpinsByScatters;
    return cores >= table.length ? (table.at(-1) ?? 0) : (table[cores] ?? 0);
  }

  #cores(): number[] {
    return this.#grid.flatMap((symbol, cell) => (symbol === CORE ? [cell] : []));
  }

  #take<T extends RoundEvent['t']>(t: T): Of<T> {
    const event = this.#events[this.#at];
    if (event?.t !== t) this.#fail(`ожидалось событие ${t}, пришло ${event?.t ?? 'конец списка'}`);
    this.#at += 1;
    return event as Of<T>;
  }

  #expect(actual: unknown, expected: unknown, what: string): void {
    if (!isDeepStrictEqual(actual, expected)) {
      this.#fail(`${what}: ожидалось ${JSON.stringify(expected)}, в событии ${JSON.stringify(actual)}`);
    }
  }

  #fail(message: string): never {
    throw new ModelMismatch(`событие ${String(this.#at)}: ${message}`);
  }
}

/** Сверяет раунд с моделью; расхождение — ModelMismatch с номером события. */
export function verifyRound(config: GameConfig, events: readonly RoundEvent[]): RoundFacts {
  return new RoundModel(config, events).run();
}
