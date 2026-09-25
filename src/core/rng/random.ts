/** Источник 32-битных слов для движка. */
export interface Random {
  /** Целое от 0 до 2^32 − 1. */
  nextU32(): number;
}
