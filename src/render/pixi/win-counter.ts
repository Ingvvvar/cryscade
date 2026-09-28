// Число выигрыша (§9, §11): BitmapText из Unbounded — счётчик крутится в Pixi, не в React. Шрифт ставится
// только после document.fonts.load: иначе глифы выпеклись бы запасным шрифтом. Ставится один раз на страницу
// и не снимается: его текстура, побывав в батче WebGPU, держится модульным кэшем Pixi (как источник атласа).

import { BitmapFont, BitmapText, Cache, type Container } from 'pixi.js';
import { PALETTE } from '../art/palette.ts';
import { type Design } from '../layout.ts';

export const DIGITS_FONT = 'cryscade-digits';
const FACE = 'Unbounded Variable';
/** Цифры, разделители uk-UA (запятая, неразрывные пробелы) и знаки множителя. */
const CHARS = ['0123456789', ',.', '   ', '×−+'];

/** Шрифт готов: document.fonts видел Unbounded в момент установки. */
export async function ensureDigitsFont(): Promise<boolean> {
  await document.fonts.load(`700 64px "${FACE}"`);
  const ready = document.fonts.check(`700 64px "${FACE}"`);
  if (!Cache.has(`${DIGITS_FONT}-bitmap`)) {
    BitmapFont.install({
      name: DIGITS_FONT,
      chars: CHARS,
      resolution: 2,
      padding: 4,
      style: { fontFamily: FACE, fontSize: 64, fontWeight: '700', fill: 0xffffff },
    });
  }
  return ready;
}

export class WinCounter {
  readonly view: BitmapText;
  #design: Design | null = null;

  constructor(parent: Container) {
    this.view = new BitmapText({ text: '0,00', style: { fontFamily: DIGITS_FONT, fontSize: 52 }, tint: PALETTE.warm });
    parent.addChild(this.view);
  }

  setDesign(design: Design): void {
    this.#design = design;
    this.#place();
  }

  set text(value: string) {
    this.view.text = value;
    this.#place();
  }

  /** Портрет: слева в своей зоне, рядом с подписью; ландшафт: по центру под подписью. */
  #place(): void {
    const design = this.#design;
    if (design === null) return;
    const zone = design.zones.winValue;
    const portrait = design.width < design.height;
    this.view.anchor.set(portrait ? 0 : 0.5, 0.5);
    this.view.position.set(portrait ? zone.x : zone.x + zone.width / 2, zone.y + zone.height / 2);
  }
}
