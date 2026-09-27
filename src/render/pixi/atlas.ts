// Общий атлас §9: выпекается один раз в RenderTexture по плану art/atlas-plan.ts; все кадры — одна базовая
// текстура, один батч. Разрешение текстуры — ATLAS_RESOLUTION, кадры — в единицах дизайна: спрайт из атласа
// сразу нужного размера. Пустые кадры плана (свечение, осколки, рамка, блики) дорисовываются следующим шагом.

import { Container, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from 'pixi.js';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { atlasEntries, planAtlas, symbolKey, type AtlasKey, type AtlasPlan } from '../art/atlas-plan.ts';
import { OUTLINE, symbolArt, type SymbolArt } from '../art/crystal.ts';
import { PALETTE } from '../art/palette.ts';
import { CELL } from '../layout.ts';

function drawSymbol(g: Graphics, art: SymbolArt): void {
  if (art.kind === 'crystal') {
    for (const facet of art.facets) g.poly([...facet.points]).fill(facet.innerColor);
  } else {
    for (const ray of art.rays) g.poly([...ray.points]).fill(ray.innerColor);
    g.circle(0, 0, art.body.radius).fill(art.body.stops[1]?.color ?? PALETTE.glow);
  }
  g.poly([...art.silhouette]).stroke({ width: OUTLINE.width, color: OUTLINE.color, join: 'round' });
}

function drawBacking(g: Graphics): void {
  const half = CELL / 2 - 3;
  g.roundRect(-half, -half, 2 * half, 2 * half, 10).fill(PALETTE.cave1);
  g.moveTo(-half + 8, -half + 1.5)
    .lineTo(half - 8, -half + 1.5)
    .stroke({ width: 1.5, color: PALETTE.frame, alpha: 0.35 });
}

export class CrystalAtlas {
  readonly plan: AtlasPlan;
  readonly #texture: RenderTexture;
  readonly #frames = new Map<AtlasKey, Texture>();

  constructor(renderer: Renderer) {
    this.plan = planAtlas(atlasEntries());
    const { resolution } = this.plan;
    this.#texture = RenderTexture.create({
      width: this.plan.width / resolution,
      height: this.plan.height / resolution,
      resolution,
      antialias: true,
      label: 'crystal-atlas',
    });
    const bake = new Container();
    for (const frame of this.plan.frames) {
      const rect = new Rectangle(frame.x / resolution, frame.y / resolution, frame.width / resolution, frame.height / resolution);
      this.#frames.set(frame.key, new Texture({ source: this.#texture.source, frame: rect, label: frame.key }));
      const g = new Graphics();
      g.position.set(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (frame.key === 'backing') drawBacking(g);
      bake.addChild(g);
    }
    for (let s = 0; s < SYMBOL_COUNT; s++) {
      const symbol = s as SymbolId;
      const target = this.#frames.get(symbolKey(symbol))?.frame;
      if (target === undefined) continue;
      const g = new Graphics();
      g.position.set(target.x + target.width / 2, target.y + target.height / 2);
      drawSymbol(g, symbolArt(symbol));
      bake.addChild(g);
    }
    renderer.render({ container: bake, target: this.#texture, clear: true });
    bake.destroy({ children: true });
  }

  texture(key: AtlasKey): Texture {
    const texture = this.#frames.get(key);
    if (texture === undefined) throw new Error(`в атласе нет кадра ${key}`);
    return texture;
  }

  /** Весь атлас одной текстурой — для выгрузки на просмотр. */
  get whole(): RenderTexture {
    return this.#texture;
  }

  /**
   * Кадры и текстура — без источника. В Pixi 8.21 группы привязок батча WebGPU живут в модульном кэше
   * (getTextureBatchBindGroup) дольше приложения, и уничтожение источника даёт предупреждение «destroyed while
   * still bound» даже после app.destroy. GPU-память источника уходит вместе с рендерером: WebGPU — device.destroy,
   * WebGL — потеря контекста; JS-объект остаётся в кэше Pixi — по одному на перемонтирование рендерера.
   */
  destroy(): void {
    for (const texture of this.#frames.values()) texture.destroy(false);
    this.#frames.clear();
    this.#texture.destroy(false);
  }
}
