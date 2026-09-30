// Числа множителей (§9, решение владельца 8): тёмная плашка у нижнего края клетки, число ×N — цвета уровня; подложка
// клетки остаётся тёмной. Во фриспинах точки «заперты» — замок в плашке (§9). Плашки — над подсветкой и выигравшими
// символами: множитель под кластером виден всегда. Число меняется только со сменой уровня.

import { Container, NineSliceSprite, Sprite } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import type { SceneState } from '../../core/presentation/index.ts';
import { CHIP } from '../art/atlas-plan.ts';
import { MULTIPLIER_COLORS, PALETTE } from '../art/palette.ts';
import type { Rect } from '../layout.ts';
import type { CrystalAtlas } from './atlas.ts';
import { DIGITS_FONT } from './fonts.ts';
import { GlyphNumber } from './glyph-number.ts';
import type { GridView } from './grid-view.ts';

/** Центр плашки ниже центра клетки: низ плашки — на краю подложки. Единицы дизайна. */
export const CHIP_OFFSET_Y = 29;
const DIGIT_SIZE = 16;
const PAD = 7;
const LOCK_WIDTH = 12;
const MULTIPLY = 0xd7;
const FIRST_LEVEL = 2;
/** Всплеск плашки, когда уровень сменился: доля размера на пике. */
const POP = 0.25;

class Chip {
  readonly view = new Container({ visible: false });
  readonly #pill: NineSliceSprite;
  readonly #lock: Sprite;
  readonly #number: GlyphNumber;
  #level = -1;
  #locked = false;

  constructor(atlas: CrystalAtlas) {
    this.#pill = new NineSliceSprite({
      texture: atlas.texture('chip'),
      leftWidth: CHIP.cap,
      rightWidth: CHIP.cap,
      topHeight: CHIP.height / 2,
      bottomHeight: CHIP.height / 2,
    });
    this.#lock = new Sprite({ texture: atlas.texture('lock'), anchor: 0.5, visible: false });
    this.#number = new GlyphNumber({ font: DIGITS_FONT, size: DIGIT_SIZE, tint: PALETTE.text, anchorX: 0, anchorY: 0.5, capacity: 4 });
    this.view.addChild(this.#pill, this.#lock, this.#number.view);
  }

  show(level: number, locked: boolean, pop: number): void {
    this.view.visible = true;
    if (level !== this.#level || locked !== this.#locked) {
      this.#level = level;
      this.#locked = locked;
      this.#layout(level, locked);
    }
    this.view.scale.set(pop >= 0 ? 1 + POP * Math.sin(Math.PI * pop) : 1);
  }

  hide(): void {
    this.view.visible = false;
  }

  destroy(): void {
    this.#number.destroy();
    this.view.destroy({ children: true });
  }

  #layout(level: number, locked: boolean): void {
    const color = MULTIPLIER_COLORS[level - FIRST_LEVEL] ?? PALETTE.text;
    this.#number.integer(2 ** (level - 1), MULTIPLY);
    this.#number.tint = color;
    const lock = locked ? LOCK_WIDTH : 0;
    const width = Math.max(CHIP.width, this.#number.width + 2 * PAD + lock);
    this.#pill.width = width;
    this.#pill.height = CHIP.height;
    this.#pill.position.set(-width / 2, -CHIP.height / 2);
    const left = -width / 2 + PAD;
    this.#lock.visible = locked;
    this.#lock.tint = color;
    this.#lock.position.set(left + LOCK_WIDTH / 2 - 1, 0);
    this.#number.view.position.set(left + lock, 0);
  }
}

export class SpotChips {
  readonly view = new Container({ label: 'spot-chips' });
  readonly #chips: Chip[] = [];

  constructor(atlas: CrystalAtlas) {
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const chip = new Chip(atlas);
      this.#chips.push(chip);
      this.view.addChild(chip.view);
    }
  }

  /** Плашки встают по клеткам сетки. */
  place(grid: GridView): void {
    this.#chips.forEach((chip, cell) => {
      chip.view.position.set(grid.centerX(cell), grid.restY(cell) + CHIP_OFFSET_Y);
    });
  }

  apply(scene: SceneState): void {
    const locked = scene.freeSpinsLeft >= 0;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const chip = this.#chips[cell];
      if (chip === undefined) continue;
      const level = scene.spotLevel[cell] ?? 0;
      if (level < FIRST_LEVEL) chip.hide();
      else chip.show(level, locked, scene.spotPop[cell] ?? -1);
    }
  }

  /** Видимые плашки — рамки на экране (getBounds: CSS-пиксели канваса). Для зонда, не для кадра. */
  rects(): Rect[] {
    return this.#chips
      .filter((chip) => chip.view.visible)
      .map((chip) => {
        const { x, y, width, height } = chip.view.getBounds();
        return { x, y, width, height };
      });
  }

  destroy(): void {
    for (const chip of this.#chips) chip.destroy();
    this.view.destroy({ children: true });
  }
}
