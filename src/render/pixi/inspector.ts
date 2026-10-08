// Тестовый зонд сцены — только dev и e2e-сборка: ui/main.tsx подключает его динамическим импортом под
// условием сборки, в прод-бандл он не попадает (греп с положительным контролем — tests/e2e/bundle.spec.ts).
// Наружу — только простые данные.

import { GraphicsContext, Sprite, Texture, UPDATE_PRIORITY } from 'pixi.js';
import { CELL_COUNT } from '../../core/model/grid.ts';
import { cellRect, toScreen, type ChipRect, type Layout, type Rect } from '../layout.ts';
import type { RendererInfo, SceneLabels } from '../renderer.ts';
import type { InspectableScene, SceneInspector } from './scene-inspector.ts';

interface SceneInfo extends RendererInfo {
  readonly maxBatchableTextures: number;
  readonly resolution: number;
  readonly fontReady: boolean;
}

/** GraphicsContext с установки счётчика: живые — созданные минус уничтоженные. */
interface ContextCounts {
  readonly created: number;
  readonly destroyed: number;
}

/**
 * Счётчик GraphicsContext на границе API Pixi (замер памяти §13) — как счётчик текстур на границе WebGL и WebGPU, но у
 * контекста нет API браузера, и считать можно только на классе Pixi. Рождение — присваивание uid в конструкторе
 * GraphicsContext (в том числе своего контекста каждого Graphics и прокси BitmapText): сеттер на прототипе считает и тут же
 * кладёт экземпляру обычное своё поле, дальше uid читается как всегда. Смерть — destroy(); повторный вызов не считается.
 * Ставится один раз на страницу — зондом сцены, до первой сцены.
 */
class ContextCounter {
  #created = 0;
  #destroyed = 0;

  constructor() {
    const prototype = GraphicsContext.prototype;
    const destroy: unknown = Reflect.get(prototype, 'destroy');
    if (typeof destroy !== 'function') throw new Error('у GraphicsContext нет destroy');
    const born = (): void => {
      this.#created += 1;
    };
    const died = (): void => {
      this.#destroyed += 1;
    };
    Object.defineProperty(prototype, 'uid', {
      configurable: true,
      set(this: GraphicsContext, value: unknown) {
        born();
        Object.defineProperty(this, 'uid', { value, writable: true, enumerable: true, configurable: true });
      },
    });
    Reflect.set(prototype, 'destroy', function (this: GraphicsContext, ...args: unknown[]): unknown {
      if (!this.destroyed) died();
      const result: unknown = Reflect.apply(destroy, this, args);
      return result;
    });
  }

  counts(): ContextCounts {
    return { created: this.#created, destroyed: this.#destroyed };
  }
}

/** Событие окна: сцена готова и прогрета, первый видимый кадр — следующий. По нему тест снимает счётчики GPU. */
const SCENE_READY_EVENT = 'cryscade:scene-ready';

type ControlKind = 'distinct' | 'atlas';

/** Метка кадра для замера: что на сцене в этот кадр — решает зонд страницы по показу. */
type FrameTagger = () => number;

/** Записанные кадры: длительность, мс, и метка — по индексу. */
interface FrameSamples {
  readonly ms: number[];
  readonly tags: number[];
}

/** Кадров в одном замере — с запасом на минуты игры при 120 Гц. */
const FRAME_CAPACITY = 60_000;

/**
 * Время кадра изнутри кадра (§13): от первого слушателя тикера приложения (INTERACTION, раньше часов показа) до
 * последнего (UTILITY, после render Pixi на LOW). Пишет в заранее выделенные массивы — сам кадр не нагружает.
 */
class FrameTimer {
  readonly #ms = new Float64Array(FRAME_CAPACITY);
  readonly #tags = new Uint8Array(FRAME_CAPACITY);
  readonly #tagger: FrameTagger;
  #count = 0;
  #start = 0;
  readonly begin = (): void => {
    this.#start = performance.now();
  };
  readonly end = (): void => {
    if (this.#count >= FRAME_CAPACITY) return;
    this.#ms[this.#count] = performance.now() - this.#start;
    this.#tags[this.#count] = this.#tagger();
    this.#count += 1;
  };

  constructor(tagger: FrameTagger) {
    this.#tagger = tagger;
  }

  samples(): FrameSamples {
    return { ms: Array.from(this.#ms.subarray(0, this.#count)), tags: Array.from(this.#tags.subarray(0, this.#count)) };
  }
}

export class SceneProbe implements SceneInspector {
  #scene: InspectableScene | null = null;
  #inits = 0;
  #destroys = 0;
  readonly #controls: Sprite[] = [];
  readonly #controlTextures: Texture[] = [];
  #timer: FrameTimer | null = null;
  /** Положительный контроль замера кадра: работа, которую слушатель тикера жжёт в каждом кадре, мс. */
  #workMs = 0;
  readonly #work = (): void => {
    const until = performance.now() + this.#workMs;
    while (performance.now() < until) {
      // Кадр занят: столько работы контроль прибавляет каждому кадру.
    }
  };
  /** Положительный контроль замера памяти: текстуры на GPU, которые никто не отпустит. */
  readonly #leaked: Texture[] = [];
  readonly #contexts = new ContextCounter();
  /** Положительный контроль счётчика контекстов: GraphicsContext, которые никто не уничтожит. */
  readonly #leakedContexts: GraphicsContext[] = [];

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

  chipParts(lock: boolean, digits: boolean): void {
    this.#scene?.isolateChipParts(lock, digits);
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

  /** Начать замер времени кадра; прежний замер выбрасывается. */
  startFrames(tagger: FrameTagger): void {
    const scene = this.#scene;
    if (scene === null) return;
    this.#stopTimer();
    const timer = new FrameTimer(tagger);
    scene.app.ticker.add(timer.begin, undefined, UPDATE_PRIORITY.INTERACTION);
    scene.app.ticker.add(timer.end, undefined, UPDATE_PRIORITY.UTILITY);
    this.#timer = timer;
  }

  /** Остановить замер и отдать кадры; замера не было — пусто. */
  stopFrames(): FrameSamples {
    const samples = this.#timer?.samples() ?? { ms: [], tags: [] };
    this.#stopTimer();
    return samples;
  }

  /** Положительный контроль замера кадра: слушатель NORMAL жжёт ms в каждом кадре; 0 — снять. */
  frameWork(ms: number): void {
    const ticker = this.#scene?.app.ticker;
    if (ticker === undefined) return;
    ticker.remove(this.#work);
    this.#workMs = ms;
    if (ms > 0) ticker.add(this.#work, undefined, UPDATE_PRIORITY.NORMAL);
  }

  /** Положительный контроль замера памяти: ещё одна текстура на GPU — из сборщика Pixi выведена, не отпускается. */
  leakTexture(): void {
    const scene = this.#scene;
    if (scene === null) return;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    // Пустой холст WebGPU не копирует в текстуру (copyExternalImageToTexture: «fails extracting valid resource»).
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('нет 2D-контекста для текстуры контроля');
    context.fillStyle = `rgb(${String(this.#leaked.length % 256)}, 64, 160)`;
    context.fillRect(0, 0, 64, 64);
    const texture = Texture.from(canvas);
    texture.source.autoGarbageCollect = false;
    scene.app.renderer.texture.initSource(texture.source);
    this.#leaked.push(texture);
  }

  /** GraphicsContext с загрузки зонда: созданные и уничтоженные на границе API Pixi. */
  graphicsContexts(): ContextCounts {
    return this.#contexts.counts();
  }

  /** Положительный контроль счётчика контекстов: ещё один GraphicsContext — не уничтожается никогда. */
  leakContext(): void {
    this.#leakedContexts.push(new GraphicsContext());
  }

  /** Текстуры контроля не уничтожаются: побывав в батче WebGPU, источник держит модульный кэш Pixi (atlas.ts). */
  removeControlSprites(): void {
    for (const sprite of this.#controls) sprite.destroy();
    this.#controls.length = 0;
  }

  #stopTimer(): void {
    const timer = this.#timer;
    const ticker = this.#scene?.app.ticker;
    if (timer !== null && ticker !== undefined) {
      ticker.remove(timer.begin);
      ticker.remove(timer.end);
    }
    this.#timer = null;
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
