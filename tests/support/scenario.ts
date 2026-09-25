import { EventRecorder, RoundEngine, SilentRecorder, type SymbolSource } from '../../src/core/engine/index.ts';
import type { GameConfig, SpinMode } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';

// Литеральные сценарии: сетку и досыпку задаёт внедряемый источник символов, а не подбор сидов.
// Буквы — id символов: Q0 A1 C2 E3 S4 R5 D6 *7; точка — клетка, которую источник не отдаёт.

const LETTERS = 'QACESRD*';
const SIDE = 7;

export interface ScenarioStep {
  readonly kind: 'fill' | 'drops';
  readonly mode: SpinMode;
  /** Клетки в порядке, в котором движок обязан их спросить: по возрастанию. */
  readonly cells: readonly number[];
  readonly symbols: readonly number[];
}

function parse(rows: readonly string[]): (number | null)[] {
  if (rows.length !== SIDE || rows.some((row) => row.length !== SIDE)) {
    throw new Error(`сценарий: ожидается 7 строк по 7 знаков: ${JSON.stringify(rows)}`);
  }
  return Array.from(rows.join(''), (char) => {
    if (char === '.') return null;
    const id = LETTERS.indexOf(char);
    if (id < 0) throw new Error(`сценарий: неизвестный знак «${char}»`);
    return id;
  });
}

function step(kind: ScenarioStep['kind'], mode: SpinMode, rows: readonly string[]): ScenarioStep {
  const parsed = parse(rows);
  const cells = parsed.flatMap((symbol, cell) => (symbol === null ? [] : [cell]));
  return { kind, mode, cells, symbols: cells.map((cell) => parsed[cell] ?? -1) };
}

/** Новая сетка спина: все 49 клеток. */
export function fill(mode: SpinMode, rows: readonly string[]): ScenarioStep {
  const result = step('fill', mode, rows);
  if (result.cells.length !== SIDE * SIDE) throw new Error('сценарий: заполнение задаёт все 49 клеток');
  return result;
}

/** Досыпка после падения: только пустые клетки, остальные — точки. */
export function drops(mode: SpinMode, rows: readonly string[]): ScenarioStep {
  return step('drops', mode, rows);
}

/** Сетка из строк — для ожиданий. */
export function grid(rows: readonly string[]): number[] {
  return parse(rows).map((symbol) => symbol ?? -1);
}

export function letters(cells: readonly number[]): string[] {
  const text = cells.map((symbol) => LETTERS[symbol] ?? '?').join('');
  return Array.from({ length: SIDE }, (_, row) => text.slice(row * SIDE, row * SIDE + SIDE));
}

// Фон без кластеров: чётные колонки — Q C S, нечётные — A E R, соседи по вертикали различны.
// Соседи по горизонтали всегда из разных семейств, поэтому ни падение, ни досыпка в тон колонке кластера не дают.
// Бриллиант и ядро в фоне не встречаются — кластеры и ядра сценария видны сразу.
export const BACKGROUND = ['QACESRQ', 'CESRQAC', 'SRQACES', 'QACESRQ', 'CESRQAC', 'SRQACES', 'QACESRQ'];

export function deadSpins(count: number): ScenarioStep[] {
  return Array.from({ length: count }, () => fill('free', BACKGROUND));
}

/** Строго проверяет каждый запрос движка: режим и клетку. Лишний запрос — ошибка, а не случайный символ. */
export class ScenarioSource implements SymbolSource {
  readonly #steps: readonly ScenarioStep[];
  #step = 0;
  #index = 0;

  constructor(steps: readonly ScenarioStep[]) {
    this.#steps = steps;
  }

  get remaining(): number {
    return this.#steps.length - this.#step;
  }

  next(mode: SpinMode, cell: number): number {
    const current = this.#steps[this.#step];
    if (current === undefined) {
      throw new Error(`сценарий исчерпан: движок спросил клетку ${String(cell)} (${mode})`);
    }
    const expected = current.cells[this.#index];
    if (mode !== current.mode || cell !== expected) {
      throw new Error(
        `шаг ${String(this.#step + 1)} (${current.kind} ${current.mode}): ожидалась клетка ${String(expected)}, ` +
          `движок спросил ${String(cell)} (${mode})`,
      );
    }
    const symbol = current.symbols[this.#index] ?? -1;
    this.#index += 1;
    if (this.#index === current.cells.length) {
      this.#step += 1;
      this.#index = 0;
    }
    return symbol;
  }
}

function assertConsumed(source: ScenarioSource): void {
  if (source.remaining !== 0) throw new Error(`сценарий не израсходован: осталось шагов ${String(source.remaining)}`);
}

/**
 * Играет раунды сценария на одном движке с записью и отдельно — в тихом режиме.
 * Итог тихого режима обязан совпасть с записанным, а end — с итогом.
 */
export function playScenario(config: GameConfig, steps: readonly ScenarioStep[], rounds = 1): RoundEvent[][] {
  const recorder = new EventRecorder();
  const source = new ScenarioSource(steps);
  const engine = new RoundEngine(config, source, recorder);
  const played: RoundEvent[][] = [];
  const totals: number[] = [];
  for (let round = 0; round < rounds; round++) {
    totals.push(engine.play());
    played.push([...recorder.events]);
  }
  assertConsumed(source);

  const silentSource = new ScenarioSource(steps);
  const silent = new RoundEngine(config, silentSource, new SilentRecorder());
  for (let round = 0; round < rounds; round++) {
    const total = silent.play();
    const last = played[round]?.at(-1);
    if (total !== totals[round] || last?.t !== 'end' || last.payX100 !== total) {
      throw new Error(`раунд ${String(round + 1)}: тихий режим ${String(total)}, запись ${String(totals[round])}`);
    }
  }
  assertConsumed(silentSource);
  return played;
}

export function playOne(config: GameConfig, steps: readonly ScenarioStep[]): RoundEvent[] {
  return playScenario(config, steps)[0] ?? [];
}

/**
 * Сетки после каждого fill и refill, восстановленные только по событиям. Не повторяет алгоритм движка:
 * собирает новую сетку из уцелевших, сдвинутых и досыпанных клеток и требует, чтобы каждая клетка
 * получила символ ровно один раз.
 */
export function gridsAfterSteps(events: readonly RoundEvent[]): string[][] {
  const snapshots: string[][] = [];
  let current: number[] = [];
  let exploded = new Set<number>();
  for (const event of events) {
    if (event.t === 'fill') {
      current = [...event.grid];
      snapshots.push(letters(current));
    } else if (event.t === 'explode') {
      exploded = new Set(event.cells);
    } else if (event.t === 'refill') {
      const moved = new Set(event.moves.map(([from]) => from));
      const next: (number | null)[] = current.map((symbol, cell) => (exploded.has(cell) || moved.has(cell) ? null : symbol));
      const place = (cell: number, symbol: number): void => {
        if (next[cell] !== null) throw new Error(`refill: клетка ${String(cell)} занята дважды`);
        next[cell] = symbol;
      };
      for (const [from, to] of event.moves) place(to, current[from] ?? -1);
      for (const { cell, symbol } of event.drops) place(cell, symbol);
      if (next.some((symbol) => symbol === null)) throw new Error('refill: после досыпки остались пустые клетки');
      current = next.map((symbol) => symbol ?? -1);
      exploded = new Set();
      snapshots.push(letters(current));
    }
  }
  return snapshots;
}
