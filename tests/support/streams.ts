import type { SymbolSource } from '../../src/core/engine/index.ts';
import type { SpinMode } from '../../src/core/model/config.ts';

/**
 * Источник символов из двух бесконечных потоков fast-check: свой поток на основную игру и на фриспины.
 * Даёт property-тестам редкие структуры, до которых ГСЧ с игровыми весами почти не доходит:
 * большие группы ядер, 7+ ядер, кап при ядрах, уровень ×128.
 */
export class StreamSource implements SymbolSource {
  readonly #base: Iterator<number>;
  readonly #free: Iterator<number>;

  constructor(base: Iterable<number>, free: Iterable<number>) {
    this.#base = base[Symbol.iterator]();
    this.#free = free[Symbol.iterator]();
  }

  next(mode: SpinMode): number {
    const step = (mode === 'base' ? this.#base : this.#free).next();
    if (step.done === true) throw new Error('StreamSource: поток кончился');
    return step.value;
  }
}
