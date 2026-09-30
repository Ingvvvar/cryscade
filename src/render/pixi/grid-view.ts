// Сетка 7×7 в единицах дизайна: подложки, кромки точек и символы — по спрайту на клетку, как устроен SceneState.
// Своих часов нет: кадр приходит из sampleScene (apply), сетка его только ставит. Край сетки — без маски (маска в
// Pixi 8.21 — трафарет и лишние draw-call): символ над сеткой и под ней невидим и проявляется, пересекая край.
// Выигравшие символы поднимаются в слой над подсветками (RenderLayer §10): трансформации остаются у сетки.

import { Container, Sprite, type RenderLayer, type Texture } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { EMPTY_CELL, type SceneState } from '../../core/presentation/index.ts';
import { symbolKey } from '../art/atlas-plan.ts';
import { MULTIPLIER_COLORS, PALETTE } from '../art/palette.ts';
import { CELL, cellRect, type Design } from '../layout.ts';
import type { CrystalAtlas } from './atlas.ts';

/** Уровень точки §4.7: 1 — отметка, 2…8 — ×2…×128. */
const MARK_LEVEL = 1;
const TOP_LEVEL = 8;
/** Всплеск кромки, когда уровень точки сменился: доля размера на пике. */
const SPOT_POP = 0.12;

export class GridView {
  readonly view = new Container({ label: 'grid' });
  readonly #backings = new Container({ label: 'backings' });
  readonly #rimLayer = new Container({ label: 'spot-rims' });
  readonly #symbolLayer = new Container({ label: 'symbols' });
  readonly #symbols: Sprite[] = [];
  readonly #rims: Sprite[] = [];
  readonly #textures: Texture[] = [];
  readonly #mark: Texture;
  readonly #rim: Texture;
  readonly #rimTop: Texture;
  readonly #centerX = new Float64Array(CELL_COUNT);
  readonly #restY = new Float64Array(CELL_COUNT);
  /** 1 — символ клетки поднят в слой выигравших. */
  readonly #lifted = new Uint8Array(CELL_COUNT);
  readonly #winners: RenderLayer;
  #fadeTop = 0;
  #fadeBottom = 0;
  #shown = false;

  constructor(atlas: CrystalAtlas, winners: RenderLayer) {
    this.#winners = winners;
    for (let symbol = 0; symbol < SYMBOL_COUNT; symbol++) this.#textures.push(atlas.texture(symbolKey(symbol as SymbolId)));
    this.#mark = atlas.texture('mark');
    this.#rim = atlas.texture('rim');
    this.#rimTop = atlas.texture('rim-iridescent');
    const backing = atlas.texture('backing');
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      this.#backings.addChild(new Sprite({ texture: backing, anchor: 0.5 }));
      const rim = new Sprite({ texture: this.#rim, anchor: 0.5, visible: false });
      this.#rims.push(rim);
      this.#rimLayer.addChild(rim);
      const symbol = new Sprite({ anchor: 0.5, visible: false });
      this.#symbols.push(symbol);
      this.#symbolLayer.addChild(symbol);
    }
    this.view.addChild(this.#backings, this.#rimLayer, this.#symbolLayer);
  }

  /** Клетки встают по зонам раскладки. */
  setDesign(design: Design): void {
    const { grid } = design.zones;
    this.#fadeTop = grid.y - CELL / 2;
    this.#fadeBottom = grid.y + grid.height + CELL / 2;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const rect = cellRect(design, cell);
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      this.#centerX[cell] = x;
      this.#restY[cell] = y;
      this.#backings.children[cell]?.position.set(x, y);
      this.#rims[cell]?.position.set(x, y);
      this.#symbols[cell]?.position.set(x, y);
    }
  }

  /** Центр клетки по x и точка покоя по y, единицы дизайна. */
  centerX(cell: number): number {
    return this.#centerX[cell] ?? 0;
  }

  restY(cell: number): number {
    return this.#restY[cell] ?? 0;
  }

  /** Кадр: символы на высоте над покоем, альфа с краем сетки, масштаб; кромки точек по уровню. */
  apply(scene: SceneState): void {
    let shown = false;
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const sprite = this.#symbols[cell];
      if (sprite === undefined) continue;
      const symbol = scene.symbol[cell] ?? EMPTY_CELL;
      const lifted = symbol !== EMPTY_CELL && ((scene.highlight[cell] ?? 0) > 0 || (scene.explode[cell] ?? -1) >= 0);
      this.#lift(cell, sprite, lifted);
      if (symbol === EMPTY_CELL) {
        sprite.visible = false;
      } else {
        shown = true;
        const texture = this.#textures[symbol];
        if (texture !== undefined && sprite.texture !== texture) sprite.texture = texture;
        const y = (this.#restY[cell] ?? 0) - (scene.offsetY[cell] ?? 0) * CELL;
        sprite.y = y;
        const top = Math.min(1, Math.max(0, (y - this.#fadeTop) / CELL));
        const bottom = Math.min(1, Math.max(0, (this.#fadeBottom - y) / CELL));
        sprite.alpha = (scene.alpha[cell] ?? 1) * top * bottom;
        sprite.scale.set(scene.scale[cell] ?? 1);
        sprite.visible = sprite.alpha > 0;
      }
      this.#spot(cell, scene.spotLevel[cell] ?? 0, scene.spotPop[cell] ?? -1);
    }
    this.#shown = shown;
  }

  /** На поле есть символы: первая сетка пришла. До неё покоя нет — её присылает authenticate. */
  get shown(): boolean {
    return this.#shown;
  }

  destroy(): void {
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const sprite = this.#symbols[cell];
      if (sprite !== undefined) this.#lift(cell, sprite, false);
    }
    this.view.destroy({ children: true });
  }

  #lift(cell: number, sprite: Sprite, lifted: boolean): void {
    const was = this.#lifted[cell] === 1;
    if (was === lifted) return;
    this.#lifted[cell] = lifted ? 1 : 0;
    if (lifted) this.#winners.attach(sprite);
    else this.#winners.detach(sprite);
  }

  #spot(cell: number, level: number, pop: number): void {
    const rim = this.#rims[cell];
    if (rim === undefined) return;
    if (level < MARK_LEVEL) {
      rim.visible = false;
      return;
    }
    rim.visible = true;
    const texture = level === MARK_LEVEL ? this.#mark : level === TOP_LEVEL ? this.#rimTop : this.#rim;
    if (rim.texture !== texture) rim.texture = texture;
    rim.tint = level === MARK_LEVEL || level === TOP_LEVEL ? 0xffffff : (MULTIPLIER_COLORS[level - 2] ?? PALETTE.text);
    rim.scale.set(pop >= 0 ? 1 + SPOT_POP * Math.sin(Math.PI * pop) : 1);
  }
}
