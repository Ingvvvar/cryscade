// Палитра §9: токены грота, кристаллы, уровни множителей.

import { SYMBOL, type SymbolId } from '../../core/model/symbols.ts';

export const PALETTE = {
  cave0: 0x050814,
  cave1: 0x0b1230,
  cave2: 0x13204a,
  glow: 0x3fe0d0,
  frame: 0x9fb4e8,
  warm: 0xffc46b,
  text: 0xeef3ff,
  muted: 0x8a97c4,
} as const;

/** Основной цвет кристалла; у Ядра — цвет края сферы, центр — белый. */
export const SYMBOL_COLORS: Readonly<Record<SymbolId, number>> = {
  [SYMBOL.quartz]: 0xcfe8ff,
  [SYMBOL.amethyst]: 0x9b6bff,
  [SYMBOL.citrine]: 0xffc93d,
  [SYMBOL.emerald]: 0x1fc98a,
  [SYMBOL.sapphire]: 0x2f6bff,
  [SYMBOL.ruby]: 0xff2e63,
  [SYMBOL.diamond]: 0xf4f8ff,
  [SYMBOL.core]: 0x3fe0d0,
};

/** Уровни множителей ×2…×128 по возрастанию; ×128 — белый с переливом. */
export const MULTIPLIER_COLORS: readonly number[] = [0x7de3ff, 0x7dffb0, 0xffe27d, 0xffb36b, 0xff7da8, 0xd07dff, 0xffffff];

/** Радужная дисперсия Бриллианта: оттенки, которые по очереди подмешиваются в грани. */
export const DISPERSION: readonly number[] = [0xff9ec7, 0xffe08a, 0x8af0ff, 0xb9a2ff];
