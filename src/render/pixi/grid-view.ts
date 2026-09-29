// Сетка 7×7 в единицах дизайна: подложки клеток и символы. Символы берутся из пула; первая сетка падает
// колонками по core/presentation/fall.ts. Край сетки — без маски (маска в Pixi 8.21 — трафарет и лишние
// draw-call): символ над сеткой невидим и проявляется, пересекая её верхний край.
// До фазы 5 часы падения живут здесь; потом их забирает sampleScene.

import { Container, Sprite } from 'pixi.js';
import { CELL_COUNT, GRID_SIDE } from '../../core/model/grid.ts';
import type { SymbolId } from '../../core/model/symbols.ts';
import { FALL, columnStartMs, fallHeight, gridSettleMs, type FallProfile } from '../../core/presentation/fall.ts';
import { symbolKey } from '../art/atlas-plan.ts';
import { CELL, cellRect, type Design } from '../layout.ts';
import { Pool } from '../pool.ts';
import type { CrystalAtlas } from './atlas.ts';

/** Сетка на экране плюс падающая: каскады фазы 5 держат обе. */
const SYMBOL_POOL = 2 * CELL_COUNT;
/** Колонка стартует целиком над сеткой. */
const FALL_DISTANCE = GRID_SIDE * CELL;

export class GridView {
  readonly view = new Container({ label: 'grid' });
  readonly #atlas: CrystalAtlas;
  readonly #backings = new Container({ label: 'backings' });
  readonly #symbolLayer = new Container({ label: 'symbols' });
  readonly #pool: Pool<Sprite>;
  readonly #shown: Sprite[] = [];
  readonly #restY = new Float64Array(CELL_COUNT);
  #gridTop = 0;
  #profile: FallProfile = FALL.normal;
  #timeMs = 0;

  constructor(atlas: CrystalAtlas) {
    this.#atlas = atlas;
    const backing = atlas.texture('backing');
    for (let cell = 0; cell < CELL_COUNT; cell++) this.#backings.addChild(new Sprite({ texture: backing, anchor: 0.5 }));
    this.#pool = new Pool<Sprite>(
      SYMBOL_POOL,
      () => {
        const sprite = new Sprite({ anchor: 0.5, visible: false });
        this.#symbolLayer.addChild(sprite);
        return sprite;
      },
      (sprite) => {
        sprite.visible = false;
      },
    );
    this.view.addChild(this.#backings, this.#symbolLayer);
  }

  /** Клетки встают по зонам раскладки. */
  setDesign(design: Design): void {
    this.#gridTop = design.zones.grid.y;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const rect = cellRect(design, cell);
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      this.#backings.children[cell]?.position.set(x, y);
      this.#restY[cell] = y;
      this.#shown[cell]?.position.set(x, y);
    }
    this.#place();
  }

  /** Новая сетка: символы из пула, падение с начала. */
  show(grid: readonly SymbolId[]): void {
    if (grid.length !== CELL_COUNT) throw new RangeError(`сетка — ${String(CELL_COUNT)} символов, получено ${String(grid.length)}`);
    for (const sprite of this.#shown) this.#pool.release(sprite);
    this.#shown.length = 0;
    grid.forEach((symbol, cell) => {
      const sprite = this.#pool.acquire();
      sprite.texture = this.#atlas.texture(symbolKey(symbol));
      sprite.visible = true;
      sprite.x = this.#backings.children[cell]?.x ?? 0;
      this.#shown.push(sprite);
    });
    this.#timeMs = 0;
    this.#place();
  }

  setReducedMotion(on: boolean): void {
    this.#profile = on ? FALL.reduced : FALL.normal;
  }

  /** Шаг часов падения; после покоя — ничего не делает. */
  update(deltaMs: number): void {
    if (this.settled) return;
    this.#timeMs += deltaMs;
    this.#place();
  }

  /** Сетка показана и упала. До первой сетки покоя нет: её присылает authenticate. */
  get settled(): boolean {
    return this.#shown.length > 0 && this.#timeMs >= gridSettleMs(this.#profile);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  #place(): void {
    const fadeTop = this.#gridTop - CELL / 2;
    for (let cell = 0; cell < this.#shown.length; cell++) {
      const sprite = this.#shown[cell];
      if (sprite === undefined) continue;
      const column = cell % GRID_SIDE;
      const height = fallHeight(this.#profile, FALL_DISTANCE, this.#timeMs - columnStartMs(this.#profile, column));
      const y = (this.#restY[cell] ?? 0) - height;
      sprite.y = y;
      sprite.alpha = Math.min(1, Math.max(0, (y - fadeTop) / CELL));
    }
  }
}
