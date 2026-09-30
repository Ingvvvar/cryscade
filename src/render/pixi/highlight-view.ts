// Подсветка выигравших клеток (§9, §10): кадры glow-* атласа, аддитивно, по спрайту на клетку — не фильтры.
// Свечение — под выигравшими символами: символы поднимаются в слой над ним (GridView, RenderLayer).

import { Container, Sprite, type Texture } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { EMPTY_CELL, type SceneState } from '../../core/presentation/index.ts';
import { glowKey } from '../art/atlas-plan.ts';
import { SYMBOL_COLORS } from '../art/palette.ts';
import { CELL } from '../layout.ts';
import type { CrystalAtlas } from './atlas.ts';
import type { GridView } from './grid-view.ts';

export class HighlightView {
  readonly view = new Container({ label: 'highlights' });
  readonly #glows: Sprite[] = [];
  readonly #textures: Texture[] = [];
  readonly #tints: number[] = [];

  constructor(atlas: CrystalAtlas) {
    for (let symbol = 0; symbol < SYMBOL_COUNT; symbol++) {
      this.#textures.push(atlas.texture(glowKey(symbol as SymbolId)));
      this.#tints.push(SYMBOL_COLORS[symbol as SymbolId]);
    }
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const glow = new Sprite({ anchor: 0.5, blendMode: 'add', visible: false });
      this.#glows.push(glow);
      this.view.addChild(glow);
    }
  }

  apply(scene: SceneState, grid: GridView): void {
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      const glow = this.#glows[cell];
      if (glow === undefined) continue;
      const strength = scene.highlight[cell] ?? 0;
      const symbol = scene.symbol[cell] ?? EMPTY_CELL;
      if (strength <= 0 || symbol === EMPTY_CELL) {
        glow.visible = false;
        continue;
      }
      const texture = this.#textures[symbol];
      if (texture !== undefined && glow.texture !== texture) glow.texture = texture;
      glow.tint = this.#tints[symbol] ?? 0xffffff;
      glow.alpha = strength;
      glow.position.set(grid.centerX(cell), grid.restY(cell) - (scene.offsetY[cell] ?? 0) * CELL);
      glow.visible = true;
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
