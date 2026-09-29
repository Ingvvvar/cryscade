import type { KeySource } from './ports.ts';

/** Ключ идемпотентности — UUID: 36 знаков [0-9a-f-], годен протоколу (§6.1). */
export class UuidKeys implements KeySource {
  readonly #random: () => string;

  constructor(random: () => string) {
    this.#random = random;
  }

  next(): string {
    return this.#random();
  }
}
