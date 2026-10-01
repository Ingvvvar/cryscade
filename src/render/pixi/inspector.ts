// Тестовый зонд сцены — только dev и e2e-сборка: ui/main.tsx подключает его динамическим импортом под
// условием сборки, в прод-бандл он не попадает (греп с положительным контролем — tests/e2e/bundle.spec.ts).
// Наружу — только простые данные.

import { Sprite, Texture } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import { cellRect, toScreen, type ChipRect, type Layout, type Rect } from '../layout.ts';
import type { RendererInfo, SceneLabels } from '../renderer.ts';
import type { InspectableScene, SceneInspector } from './scene-inspector.ts';

export interface SceneInfo extends RendererInfo {
  readonly maxBatchableTextures: number;
  readonly resolution: number;
  readonly fontReady: boolean;
}

/** Событие окна: сцена готова и прогрета, первый видимый кадр — следующий. По нему тест снимает счётчики GPU. */
export const SCENE_READY_EVENT = 'cryscade:scene-ready';

export type ControlKind = 'distinct' | 'atlas';

export class SceneProbe implements SceneInspector {
  #scene: InspectableScene | null = null;
  #inits = 0;
  #destroys = 0;
  readonly #controls: Sprite[] = [];
  readonly #controlTextures: Texture[] = [];

  attach(scene: InspectableScene): void {
    this.#scene = scene;
    this.#inits += 1;
    window.dispatchEvent(new Event(SCENE_READY_EVENT));
  }

  detach(scene: InspectableScene): void {
    if (this.#scene === scene) {
      this.removeControlSprites();
      this.#scene = null;
    }
    this.#destroys += 1;
  }

  get inits(): number {
    return this.#inits;
  }

  get destroys(): number {
    return this.#destroys;
  }

  info(): SceneInfo | null {
    const scene = this.#scene;
    if (scene === null) return null;
    const { renderer } = scene.app;
    return { ...scene.info, maxBatchableTextures: renderer.limits.maxBatchableTextures, resolution: renderer.resolution, fontReady: scene.fontReady };
  }

  layout(): Layout | null {
    return this.#scene?.layout() ?? null;
  }

  /** Клетки сетки на экране, CSS-пиксели. */
  cells(): Rect[] {
    const layout = this.layout();
    if (layout === null) return [];
    return Array.from({ length: CELL_COUNT }, (_, cell) => toScreen(layout, cellRect(layout.design, cell)));
  }

  settled(): boolean {
    return this.#scene?.settled() ?? false;
  }

  /** Кадр при остановленном тикере: источник ставит свой кадр без хода часов, потом одна отрисовка. */
  renderOnce(): void {
    this.#scene?.step(0);
    this.#scene?.app.render();
  }

  missingGlyphs(texts: readonly string[] | null): string[] {
    return this.#scene?.missingGlyphs(texts) ?? [];
  }

  chipRects(): ChipRect[] {
    return this.#scene?.chipRects() ?? [];
  }

  plaqueText(): string | null {
    return this.#scene?.plaqueText() ?? null;
  }

  sceneLabels(): SceneLabels | null {
    return this.#scene?.labels() ?? null;
  }

  pinAmbient(seconds: number | null): void {
    this.#scene?.pinAmbient(seconds);
  }

  backgroundOnly(on: boolean): void {
    this.#scene?.backgroundOnly(on);
  }

  /** Атлас целиком — PNG в data URL, как выпечен. */
  async atlasPng(): Promise<string | null> {
    const scene = this.#scene;
    if (scene === null) return null;
    return scene.app.renderer.extract.base64(scene.atlas.whole);
  }

  stopTicker(): void {
    this.#scene?.app.stop();
  }

  startTicker(): void {
    this.#scene?.app.start();
  }

  /** Положительный контроль счётчика draw-call: разные текстуры рвут батч на maxBatchableTextures, текстура атласа — нет. */
  addControlSprites(count: number, kind: ControlKind): void {
    const scene = this.#scene;
    if (scene === null) return;
    for (let i = 0; i < count; i++) {
      const texture = kind === 'distinct' ? this.#controlTexture(i) : scene.atlas.texture('backing');
      const sprite = new Sprite({ texture, width: 4, height: 4, x: (i % 32) * 5, y: 4 + Math.floor(i / 32) * 5 });
      scene.root.addChild(sprite);
      this.#controls.push(sprite);
    }
  }

  /** Текстуры контроля не уничтожаются: побывав в батче WebGPU, источник держит модульный кэш Pixi (atlas.ts). */
  removeControlSprites(): void {
    for (const sprite of this.#controls) sprite.destroy();
    this.#controls.length = 0;
  }

  #controlTexture(index: number): Texture {
    const existing = this.#controlTextures[index];
    if (existing !== undefined) return existing;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('нет 2D-контекста для контрольной текстуры');
    context.fillStyle = `rgb(${String((index * 37) % 256)}, 128, 200)`;
    context.fillRect(0, 0, 2, 2);
    const texture = Texture.from(canvas);
    this.#controlTextures.push(texture);
    return texture;
  }
}
