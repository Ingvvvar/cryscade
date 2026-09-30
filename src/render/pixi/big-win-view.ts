// Большой выигрыш (§8.4): затемнение, уровень строкой от ui и сумма, досчитываемая из SceneState. Празднование
// пропускается целиком (§8.4) — вид ничего не решает, только ставит кадр.

import { BitmapText, Container, Graphics } from 'pixi.js';
import type { SceneState } from '../../core/presentation/index.ts';
import { PALETTE } from '../art/palette.ts';
import type { Design } from '../layout.ts';
import type { NumberCodes } from '../number-layout.ts';
import type { SceneTexts } from '../renderer.ts';
import { DIGITS_FONT, LABELS_FONT } from './fonts.ts';
import { GlyphNumber } from './glyph-number.ts';

/** Проявление и уход — доля празднования с каждого края; всплеск надписи — в начале. */
const FADE = 0.06;
const POP_SHARE = 0.12;
const POP = 0.12;

export class BigWinView {
  readonly view = new Container({ label: 'big-win', visible: false });
  readonly #dim = new Graphics();
  readonly #title: BitmapText;
  readonly #amount: GlyphNumber;
  readonly #texts: SceneTexts;
  readonly #codes: NumberCodes;
  #level = -1;

  constructor(texts: SceneTexts, codes: NumberCodes) {
    this.#texts = texts;
    this.#codes = codes;
    this.#title = new BitmapText({ text: texts.bigWin[0], style: { fontFamily: LABELS_FONT, fontSize: 52 }, tint: PALETTE.warm, anchor: 0.5 });
    this.#amount = new GlyphNumber({ font: DIGITS_FONT, size: 92, tint: PALETTE.text, anchorX: 0.5, anchorY: 0.5 });
    this.view.addChild(this.#dim, this.#title, this.#amount.view);
  }

  setDesign(design: Design): void {
    // Затемнение шире холста дизайна: при любой пропорции экрана поля по краям тоже темнеют.
    this.#dim
      .clear()
      .rect(-design.width, -design.height, 3 * design.width, 3 * design.height)
      .fill({ color: PALETTE.cave0, alpha: 0.62 });
    const { grid } = design.zones;
    const x = grid.x + grid.width / 2;
    const y = grid.y + grid.height / 2;
    this.#title.position.set(x, y - 70);
    this.#amount.view.position.set(x, y + 40);
  }

  /** still — раунд под reduced motion: надпись без всплеска. */
  apply(scene: SceneState, still: boolean): void {
    const level = scene.bigWinLevel;
    this.view.visible = level > 0;
    if (level <= 0) return;
    if (level !== this.#level) {
      this.#level = level;
      this.#title.text = this.#texts.bigWin[level - 1] ?? this.#texts.bigWin[0];
    }
    const p = scene.bigWinProgress;
    this.view.alpha = Math.min(1, p / FADE, (1 - p) / FADE);
    this.#title.scale.set(still ? 1 : 1 + POP * (1 - Math.min(1, p / POP_SHARE)));
    this.#amount.money(scene.bigWinMinor, this.#codes);
  }

  destroy(): void {
    this.#amount.destroy();
    this.view.destroy({ children: true });
  }
}
