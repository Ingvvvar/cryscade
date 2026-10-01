// Числа множителей (§9, решение владельца 8): тёмная плашка у нижнего края клетки, число ×N — цвета уровня; подложка
// клетки остаётся тёмной. Во фриспинах точки «заперты» — замок в плашке (§9). Плашки — над подсветкой и выигравшими
// символами: множитель под кластером виден всегда. Число меняется только со сменой уровня.

import { Container, NineSliceSprite, Sprite } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import type { SceneState } from '../../core/presentation/index.ts';
import { CHIP, LOCK_SCALE } from '../art/atlas-plan.ts';
import { MULTIPLIER_COLORS, PALETTE } from '../art/palette.ts';
import { CELL, type ChipRect, type Rect } from '../layout.ts';
import { BACKING_INSET, type CrystalAtlas } from './atlas.ts';
import { DIGITS_FONT } from './fonts.ts';
import { GlyphNumber } from './glyph-number.ts';
import type { GridView } from './grid-view.ts';

/** Центр плашки ниже центра клетки: низ плашки — на краю подложки. Единицы дизайна. */
export const CHIP_OFFSET_Y = CELL / 2 - BACKING_INSET - CHIP.height / 2;
/** Кегль числа (§9): при 16 ед. в портрете на телефоне шириной 390 px число выходило около 9 px. */
const DIGIT_SIZE = 22;
const PAD = 7;
/** Замок с зазором до числа. */
const LOCK_WIDTH = 12 * LOCK_SCALE;
/** Плашка не шире подложки клетки: шире — сошлась бы с плашкой соседней клетки. */
const MAX_WIDTH = CELL - 2 * BACKING_INSET;
const MULTIPLY = 0xd7;
const FIRST_LEVEL = 2;
/** Всплеск плашки, когда уровень сменился: доля размера на пике. */
const POP = 0.25;

function bounds(target: Container): Rect {
  const { x, y, width, height } = target.getBounds();
  return { x, y, width, height };
}

class Chip {
  readonly view = new Container({ visible: false });
  readonly #pill: NineSliceSprite;
  /** Замок и число: ужимаются вместе, одним масштабом. */
  readonly #content = new Container();
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
    this.#content.addChild(this.#lock, this.#number.view);
    this.view.addChild(this.#pill, this.#content);
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

  /** Какие части рисовать: замок, число. Для зонда — тест наложения снимает их порознь; кадр игры рисует обе. */
  parts(lock: boolean, digits: boolean): void {
    this.#lock.renderable = lock;
    this.#number.view.renderable = digits;
  }

  /** Рамки плашки и её содержимого — замка и числа (у глифов — прозрачные поля шрифта выше и ниже плашки). */
  rect(): ChipRect {
    return { plaque: bounds(this.#pill), content: bounds(this.#content) };
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
    // Не влезает в подложку (×64 и ×128 с замком) — число и замок ужимаются по её ширине.
    const fit = Math.min(1, (MAX_WIDTH - 2 * PAD) / (this.#number.width + lock));
    const width = Math.max(CHIP.width, fit * (this.#number.width + lock) + 2 * PAD);
    this.#pill.width = width;
    this.#pill.height = CHIP.height;
    this.#pill.position.set(-width / 2, -CHIP.height / 2);
    this.#lock.visible = locked;
    this.#lock.tint = color;
    this.#lock.position.set(LOCK_WIDTH / 2 - 1, 0);
    this.#number.view.position.set(lock, 0);
    this.#content.scale.set(fit);
    this.#content.position.set(-width / 2 + PAD, 0);
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

  /** Части плашек на кадре — для зонда (тест наложения замка и числа). */
  parts(lock: boolean, digits: boolean): void {
    for (const chip of this.#chips) chip.parts(lock, digits);
  }

  /** Видимые плашки — рамки на экране (getBounds: CSS-пиксели канваса). Для зонда, не для кадра. */
  rects(): ChipRect[] {
    return this.#chips.filter((chip) => chip.view.visible).map((chip) => chip.rect());
  }

  destroy(): void {
    for (const chip of this.#chips) chip.destroy();
    this.view.destroy({ children: true });
  }
}
