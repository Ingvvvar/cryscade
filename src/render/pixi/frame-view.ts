// Рамка сетки (§9): огранённый край — NineSliceSprite из атласа, углы не тянутся; медленный блик скользит по
// верхней грани от часов декора. Блик аддитивный: подсветки — аддитивные спрайты, не фильтры (§10).

import { Container, NineSliceSprite, Sprite } from 'pixi.js';
import { FRAME_BORDER, type Design } from '../layout.ts';
import type { CrystalAtlas } from './atlas.ts';

/** Период прохода блика, секунды; пауза в конце периода — блик за краем. */
const GLINT_PERIOD_S = 7;
const GLINT_TRAVEL = 0.7;

export class FrameView {
  readonly view = new Container({ label: 'frame' });
  readonly #edge: NineSliceSprite;
  readonly #glint: Sprite;
  #left = 0;
  #top = 0;
  #width = 1;

  constructor(atlas: CrystalAtlas) {
    this.#edge = new NineSliceSprite({
      texture: atlas.texture('frame-slice'),
      leftWidth: FRAME_BORDER,
      topHeight: FRAME_BORDER,
      rightWidth: FRAME_BORDER,
      bottomHeight: FRAME_BORDER,
    });
    this.#glint = new Sprite({ texture: atlas.texture('glint-streak'), anchor: 0.5, blendMode: 'add', alpha: 0 });
    this.view.addChild(this.#edge, this.#glint);
  }

  setDesign(design: Design): void {
    const { frame } = design.zones;
    this.#edge.position.set(frame.x, frame.y);
    this.#edge.width = frame.width;
    this.#edge.height = frame.height;
    this.#left = frame.x;
    this.#top = frame.y;
    this.#width = frame.width;
  }

  /** Блик — функция времени декора: при reduced motion время стоит, и блик стоит вместе с ним. */
  update(seconds: number): void {
    const phase = (seconds % GLINT_PERIOD_S) / GLINT_PERIOD_S / GLINT_TRAVEL;
    const inside = phase >= 0 && phase <= 1;
    this.#glint.visible = inside;
    if (!inside) return;
    this.#glint.x = this.#left + FRAME_BORDER + phase * (this.#width - 2 * FRAME_BORDER);
    this.#glint.y = this.#top + FRAME_BORDER * 0.3;
    this.#glint.alpha = Math.sin(Math.PI * phase) * 0.85;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
