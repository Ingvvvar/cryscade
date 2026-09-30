// Число выигрыша (§9, §11): счётчик крутится в Pixi, не в React. Значение — счётчик кадра (SceneState.counterMinor),
// раскладка — глифами Unbounded без строки на кадр (glyph-number.ts); разделители локали — от ui.

import { PALETTE } from '../art/palette.ts';
import { type Design } from '../layout.ts';
import type { NumberCodes } from '../number-layout.ts';
import { DIGITS_FONT } from './fonts.ts';
import { GlyphNumber } from './glyph-number.ts';

const SIZE = 52;

export class WinCounter {
  readonly #digits: GlyphNumber;
  readonly #codes: NumberCodes;
  #design: Design | null = null;

  constructor(codes: NumberCodes) {
    this.#codes = codes;
    this.#digits = new GlyphNumber({ font: DIGITS_FONT, size: SIZE, tint: PALETTE.warm, anchorX: 0.5, anchorY: 0.5 });
    this.#digits.money(0, codes);
  }

  get view(): GlyphNumber['view'] {
    return this.#digits.view;
  }

  setDesign(design: Design): void {
    this.#design = design;
    this.#place();
  }

  apply(minor: number): void {
    this.#digits.money(minor, this.#codes);
    this.#place();
  }

  destroy(): void {
    this.#digits.destroy();
  }

  /** Портрет: слева в своей зоне, рядом с подписью; ландшафт: по центру под подписью. */
  #place(): void {
    const design = this.#design;
    if (design === null) return;
    const zone = design.zones.winValue;
    const portrait = design.width < design.height;
    const x = portrait ? zone.x + this.#digits.width / 2 : zone.x + zone.width / 2;
    this.#digits.view.position.set(x, zone.y + zone.height / 2);
  }
}
