// Символы §4.1. id — индекс в таблице выплат, весах и сетке.

export const SYMBOL = {
  quartz: 0,
  amethyst: 1,
  citrine: 2,
  emerald: 3,
  sapphire: 4,
  ruby: 5,
  diamond: 6,
  core: 7,
} as const;

export type SymbolId = (typeof SYMBOL)[keyof typeof SYMBOL];

/** Ядро — скаттер: кластеров не образует, не взрывается, падает вместе с остальными. */
export const SCATTER = SYMBOL.core;

export const SYMBOL_COUNT = 8;

/** Символы, у которых есть строка в таблице выплат: id от 0 до 6. */
export const PAYING_SYMBOL_COUNT = 7;
