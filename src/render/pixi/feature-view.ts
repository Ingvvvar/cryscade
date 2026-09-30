// Фича (§9): счётчик фриспинов в зоне feature и плашки — начало фриспинов, ретриггер, кап. Надписи — строками от ui
// (SceneTexts), числа — глифами; ставятся со сменой плашки, не в каждом кадре. Ход плашки — альфа из SceneState.
// Плашка начала фриспинов — надпись, число и подсказка; ретриггер («+5 фріспінів», число внутри надписи) и кап — одна
// надпись по центру плашки.

import { BitmapText, Container, NineSliceSprite } from 'pixi.js';
import { PLAQUE, type SceneState } from '../../core/presentation/index.ts';
import { PANEL_BORDER } from '../art/atlas-plan.ts';
import { PALETTE } from '../art/palette.ts';
import type { Design } from '../layout.ts';
import type { SceneTexts } from '../renderer.ts';
import type { CrystalAtlas } from './atlas.ts';
import { DIGITS_FONT, LABELS_FONT } from './fonts.ts';
import { GlyphNumber } from './glyph-number.ts';

/** Надпись плашки начала фриспинов — над числом; одна надпись (ретриггер, кап) — по центру. */
const TITLE_ABOVE = -62;

/** Сколько фриспинов осталось — «Фріспіни 7»; только во фриспинах. */
export class FreeSpinsView {
  readonly view = new Container({ label: 'free-spins', visible: false });
  readonly #label: BitmapText;
  readonly #count: GlyphNumber;
  #portrait = true;

  constructor(texts: SceneTexts) {
    this.#label = new BitmapText({ text: texts.freeSpins, style: { fontFamily: LABELS_FONT, fontSize: 28 }, tint: PALETTE.muted });
    this.#count = new GlyphNumber({ font: DIGITS_FONT, size: 44, tint: PALETTE.warm, anchorX: 0, anchorY: 0.5, capacity: 6 });
    this.view.addChild(this.#label, this.#count.view);
  }

  setDesign(design: Design): void {
    const zone = design.zones.feature;
    this.#portrait = design.width < design.height;
    if (this.#portrait) {
      this.#label.anchor.set(1, 0.5);
      this.#label.position.set(zone.x + zone.width / 2 - 6, zone.y + zone.height / 2);
      this.#count.view.position.set(zone.x + zone.width / 2 + 6, zone.y + zone.height / 2);
    } else {
      this.#label.anchor.set(0.5, 0.5);
      this.#label.position.set(zone.x + zone.width / 2, zone.y + zone.height * 0.3);
      this.#count.view.position.set(zone.x + zone.width / 2, zone.y + zone.height * 0.62);
    }
  }

  apply(scene: SceneState): void {
    const left = scene.freeSpinsLeft;
    this.view.visible = left >= 0;
    if (left < 0) return;
    this.#count.integer(left, -1);
    // Ландшафт: число под подписью по центру; портрет: число справа от подписи.
    if (!this.#portrait) this.#count.view.pivot.x = this.#count.width / 2;
  }

  destroy(): void {
    this.#count.destroy();
    this.view.destroy({ children: true });
  }
}

/** Плашки фичи над сеткой: начало фриспинов (с подсказкой featureIntro), ретриггер, кап. */
export class PlaqueView {
  readonly view = new Container({ label: 'plaque', visible: false });
  readonly #panel: NineSliceSprite;
  readonly #title: BitmapText;
  readonly #value: GlyphNumber;
  readonly #hint: BitmapText;
  readonly #texts: SceneTexts;
  /** Показанная плашка: вид и число — смена того или другого ставит надпись заново. */
  #kind = -1;
  #shown = -1;

  constructor(atlas: CrystalAtlas, texts: SceneTexts) {
    this.#texts = texts;
    this.#panel = new NineSliceSprite({
      texture: atlas.texture('panel'),
      leftWidth: PANEL_BORDER,
      rightWidth: PANEL_BORDER,
      topHeight: PANEL_BORDER,
      bottomHeight: PANEL_BORDER,
      width: 440,
      height: 236,
    });
    this.#panel.position.set(-220, -118);
    this.#title = new BitmapText({ text: texts.freeSpins, style: { fontFamily: LABELS_FONT, fontSize: 34 }, tint: PALETTE.warm, anchor: 0.5 });
    this.#title.position.set(0, TITLE_ABOVE);
    this.#value = new GlyphNumber({ font: DIGITS_FONT, size: 88, tint: PALETTE.text, anchorX: 0.5, anchorY: 0.5, capacity: 6 });
    this.#value.view.position.set(0, 10);
    this.#hint = new BitmapText({ text: texts.tapToContinue, style: { fontFamily: LABELS_FONT, fontSize: 18 }, tint: PALETTE.muted, anchor: 0.5 });
    this.#hint.position.set(0, 82);
    this.view.addChild(this.#panel, this.#title, this.#value.view, this.#hint);
  }

  setDesign(design: Design): void {
    const { grid } = design.zones;
    this.view.position.set(grid.x + grid.width / 2, grid.y + grid.height / 2);
  }

  /** Надпись видимой плашки; плашки нет — null. Для зонда. */
  get text(): string | null {
    return this.view.visible ? this.#title.text : null;
  }

  /** still — раунд под reduced motion: плашка проявляется без роста. */
  apply(scene: SceneState, still: boolean): void {
    const kind = scene.plaque;
    this.view.visible = kind !== PLAQUE.none && scene.plaqueAlpha > 0;
    if (!this.view.visible) return;
    if (kind !== this.#kind || scene.plaqueValue !== this.#shown) {
      this.#kind = kind;
      this.#shown = scene.plaqueValue;
      const intro = kind === PLAQUE.intro;
      this.#title.text = kind === PLAQUE.cap ? this.#texts.maxWin : kind === PLAQUE.retrigger ? this.#texts.freeSpinsAdded(scene.plaqueValue) : this.#texts.freeSpins;
      this.#title.position.y = intro ? TITLE_ABOVE : 0;
      this.#hint.visible = intro;
      this.#value.view.visible = intro;
      if (intro) this.#value.integer(scene.plaqueValue, -1);
    }
    this.view.alpha = scene.plaqueAlpha;
    this.view.scale.set(still ? 1 : 0.92 + 0.08 * scene.plaqueAlpha);
  }

  destroy(): void {
    this.#value.destroy();
    this.view.destroy({ children: true });
  }
}
