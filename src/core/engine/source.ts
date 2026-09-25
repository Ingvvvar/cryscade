import type { GameConfig, SpinMode } from '../model/config.ts';
import { SYMBOL_COUNT } from '../model/symbols.ts';
import type { Random } from '../rng/index.ts';

/**
 * Единственный вход случайности в раунд (Strategy): ГСЧ в игре, сценарий в тестах.
 * Заполнение спрашивает клетки 0…48 по порядку, досыпка — пустые клетки по возрастанию (§4.7).
 */
export interface SymbolSource {
  next(mode: SpinMode, cell: number): number;
}

const U32_RANGE = 0x1_0000_0000;

/**
 * Символ по весам из u32 (§4.7): значение не меньше 2³² − (2³² mod W) отбрасывается и берётся
 * следующее, иначе u32 mod W ищется по накопленным весам в порядке id. Без смещения и без float.
 */
export class WeightedPicker {
  readonly #cumulative = new Float64Array(SYMBOL_COUNT);
  readonly #total: number;
  readonly #limit: number;

  constructor(weights: readonly number[]) {
    if (weights.length !== SYMBOL_COUNT) {
      throw new RangeError(`веса: ожидается ${String(SYMBOL_COUNT)}, получено ${String(weights.length)}`);
    }
    let total = 0;
    for (let symbol = 0; symbol < SYMBOL_COUNT; symbol++) {
      const weight = weights[symbol] ?? -1;
      if (!Number.isSafeInteger(weight) || weight < 0) {
        throw new RangeError(`вес символа ${String(symbol)}: ожидается неотрицательное целое, получено ${String(weight)}`);
      }
      total += weight;
      this.#cumulative[symbol] = total;
    }
    if (total <= 0 || total > U32_RANGE) {
      throw new RangeError(`сумма весов: ожидается от 1 до 2^32, получено ${String(total)}`);
    }
    this.#total = total;
    this.#limit = U32_RANGE - (U32_RANGE % total);
  }

  pick(random: Random): number {
    let x = random.nextU32();
    while (x >= this.#limit) x = random.nextU32();
    const r = x % this.#total;
    let symbol = 0;
    while (r >= (this.#cumulative[symbol] ?? U32_RANGE)) symbol += 1;
    return symbol;
  }
}

/** Источник символов на ГСЧ: у каждого режима своё распределение, досыпка — из того же. */
export class RngSymbolSource implements SymbolSource {
  readonly #random: Random;
  readonly #base: WeightedPicker;
  readonly #free: WeightedPicker;

  constructor(weights: GameConfig['weights'], random: Random) {
    this.#random = random;
    this.#base = new WeightedPicker(weights.base);
    this.#free = new WeightedPicker(weights.free);
  }

  next(mode: SpinMode): number {
    return (mode === 'base' ? this.#base : this.#free).pick(this.#random);
  }
}
