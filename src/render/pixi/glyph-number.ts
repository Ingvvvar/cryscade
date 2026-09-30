// Число из глифов BitmapFont (§10: прокрутка цифр — своим разбором): спрайты глифов созданы заранее, число
// раскладывается целой арифметикой (number-layout.ts) и только при смене значения — в кадре ни строки, ни объекта.
// Глиф ставится так же, как его ставит BitmapText Pixi: перо плюс смещения глифа, всё в единицах шрифта × масштаб.

import { Container, Sprite, type CharData } from 'pixi.js';
import { MAX_GLYPHS, layoutInteger, layoutMoney, type NumberCodes } from '../number-layout.ts';
import { glyphsByCode, installedFont, type InstalledFont } from './fonts.ts';

export interface GlyphNumberOptions {
  readonly font: string;
  /** Кегль, единицы дизайна. */
  readonly size: number;
  readonly tint: number;
  /** Точка привязки по ширине и высоте строки: 0 — левый/верхний край, 0.5 — середина. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Сколько глифов держать; по умолчанию — длиннейшая сумма. */
  readonly capacity?: number;
}

export class GlyphNumber {
  readonly view = new Container();
  readonly #font: InstalledFont;
  readonly #glyphs: Map<number, CharData>;
  readonly #sprites: Sprite[] = [];
  readonly #codes: Uint16Array;
  readonly #scale: number;
  readonly #anchorX: number;
  readonly #anchorY: number;
  /** Что показано: вид и значение; смена того или другого — новая раскладка. */
  #kind = -1;
  #value = -1;
  #width = 0;

  constructor(options: GlyphNumberOptions) {
    this.#font = installedFont(options.font);
    this.#glyphs = glyphsByCode(this.#font);
    this.#scale = options.size / this.#font.baseMeasurementFontSize;
    this.#anchorX = options.anchorX;
    this.#anchorY = options.anchorY;
    const capacity = options.capacity ?? MAX_GLYPHS;
    this.#codes = new Uint16Array(Math.max(capacity, MAX_GLYPHS));
    for (let i = 0; i < capacity; i++) {
      const sprite = new Sprite({ visible: false, tint: options.tint });
      sprite.scale.set(this.#scale);
      this.#sprites.push(sprite);
      this.view.addChild(sprite);
    }
  }

  /** Ширина показанного числа, единицы дизайна. */
  get width(): number {
    return this.#width;
  }

  /** Высота строки, единицы дизайна. */
  get height(): number {
    return this.#font.lineHeight * this.#scale;
  }

  set tint(value: number) {
    for (const sprite of this.#sprites) sprite.tint = value;
  }

  /** Сумма в минимальных единицах с разделителями локали. */
  money(minor: number, codes: NumberCodes): void {
    if (this.#kind === 0 && this.#value === minor) return;
    this.#kind = 0;
    this.#value = minor;
    this.#place(layoutMoney(minor, codes, this.#codes));
  }

  /** Целое с приставкой (код символа, −1 — без неё). */
  integer(value: number, prefix: number): void {
    const kind = 1 + Math.max(prefix, 0);
    if (this.#kind === kind && this.#value === value) return;
    this.#kind = kind;
    this.#value = value;
    this.#place(layoutInteger(value, prefix, this.#codes));
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  #place(length: number): void {
    if (length > this.#sprites.length) throw new RangeError(`число длиннее ${String(this.#sprites.length)} глифов`);
    let pen = 0;
    for (let i = 0; i < this.#sprites.length; i++) {
      const sprite = this.#sprites[i];
      if (sprite === undefined) continue;
      const glyph = i < length ? this.#glyphs.get(this.#codes[i] ?? 0) : undefined;
      if (glyph === undefined) {
        sprite.visible = false;
        continue;
      }
      if (glyph.texture !== undefined) {
        sprite.texture = glyph.texture;
        sprite.visible = true;
        sprite.position.set(Math.round(pen + glyph.xOffset) * this.#scale, Math.round(this.#font.baseLineOffset + glyph.yOffset) * this.#scale);
      } else {
        sprite.visible = false;
      }
      pen += glyph.xAdvance;
    }
    this.#width = pen * this.#scale;
    this.view.pivot.set(this.#anchorX * this.#width, this.#anchorY * this.height);
  }
}
