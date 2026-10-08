// Фасад рендера (§3, §10). Канвас — поколения рендерера: создаётся здесь и уничтожается с removeView: true.
// React владеет только хост-элементом: WebGL-destroy теряет контекст канваса, и новый init на том же канвасе
// вешает страницу (проба на Pixi 8.21). Свои части — атлас, фон, рамку, показ раунда — рендерер создаёт сам.
// Кадр рендер тянет сам: тикер двигает часы источника (SceneSource) и ставит его SceneState — рендер ничего не решает.
// Порядок init: приложение → шрифты → атлас → сцена → прогрев → канвас в DOM → тикер.

import { Application, Container, Sprite, type Renderer as PixiRendererBackend, type Ticker, type WebGLRenderer, type WebGPURenderer } from 'pixi.js';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { AmbientClock } from '../ambient-clock.ts';
import { ATLAS_RESOLUTION, symbolKey } from '../art/atlas-plan.ts';
import { PALETTE } from '../art/palette.ts';
import { FrameClock } from '../frame-clock.ts';
import { computeLayout, renderResolution, type Layout, type Viewport } from '../layout.ts';
import { numberCodes, type NumberCodes, type NumberStyle } from '../number-layout.ts';
import { sceneTextList, type Renderer, type RendererInfo, type RendererName, type SceneSource, type SceneTexts } from '../renderer.ts';
import { CrystalAtlas } from './atlas.ts';
import { CaveBackground } from './background.ts';
import { DIGITS_FONT, LABELS_FONT, digitTexts, ensureDigitsFont, ensureLabelsFont, fontMissing, fontPages } from './fonts.ts';
import { FrameMarks } from './frame-marks.ts';
import { FrameView } from './frame-view.ts';
import { RoundView } from './round-view.ts';
import type { InspectableScene, SceneInspector } from './scene-inspector.ts';
import { warmUp } from './warmup.ts';

interface PixiRendererOptions {
  /** Порядок попыток; рендерера вне списка не будет — принудительный ?renderer= не откатывается молча. */
  readonly preference: readonly RendererName[];
  /** Тестовый зонд; в проде — null. */
  readonly inspector: SceneInspector | null;
  /** Прогрев шейдеров и страниц глифов до первого кадра; выключается только зондом — положительный контроль его проверок. */
  readonly warmUp: boolean;
  /** Надписи сцены и разделители чисел — от ui: в render/ текста и формата нет. Язык меняет setLanguage. */
  readonly texts: SceneTexts;
  readonly numbers: NumberStyle;
  /** Надписи всех языков игрока: шрифт надписей ставится из них сразу — смена языка без новых страниц глифов. */
  readonly allTexts: readonly SceneTexts[];
}

const SOFTWARE = /swiftshader|llvmpipe|software/i;
/** Тепло фриспинов (§9) набирается и уходит за столько миллисекунд; при reduced motion — сразу. */
const WARMTH_MS = 600;

function describeRenderer(renderer: PixiRendererBackend): RendererInfo {
  if (renderer.name === 'webgpu') {
    const info = (renderer as WebGPURenderer).gpu.adapter.info;
    const gpu = [info.vendor, info.architecture, info.device, info.description].filter((part) => part !== '').join(' ');
    return { name: 'webgpu', gpu, software: info.isFallbackAdapter || SOFTWARE.test(gpu) };
  }
  if (renderer.name === 'webgl') {
    const gl = (renderer as WebGLRenderer).gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const value: unknown = debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    const gpu = String(value);
    return { name: 'webgl', gpu, software: SOFTWARE.test(gpu) };
  }
  throw new Error(`рендерер ${renderer.name} не поддерживается: нужен WebGPU или WebGL`);
}

interface Scene {
  readonly atlas: CrystalAtlas;
  readonly background: CaveBackground;
  readonly frame: FrameView;
  readonly round: RoundView;
}

export class PixiRenderer implements Renderer {
  readonly #options: PixiRendererOptions;
  #texts: SceneTexts;
  #numbers: NumberStyle;
  #codes: NumberCodes;
  readonly #root = new Container({ label: 'design' });
  readonly #ambient = new AmbientClock();
  readonly #frameClock = new FrameClock();
  /** Дробное время тикера становится целыми мс в одном месте — в часах кадра; дальше по кадру идут только целые. */
  readonly #tick = (ticker: Ticker): void => {
    const deltaMs = this.#frameClock.advance(ticker);
    this.#ambient.advance(deltaMs);
    this.#frame(deltaMs);
  };
  #app: Application | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #ready = false;
  #scene: Scene | null = null;
  #layout: Layout | null = null;
  #viewport: { readonly viewport: Viewport; readonly pixelRatio: number } | null = null;
  #reducedMotion = false;
  #source: SceneSource | null = null;
  #warmth = 0;
  #inspected: InspectableScene | null = null;
  /** Иконки символов: атлас после init не меняется — снимаются один раз на рендерер. */
  #icons: Promise<readonly string[]> | null = null;
  /** Фазы кадра для DevTools — только dev (§13). */
  #marks: FrameMarks | null = null;

  constructor(options: PixiRendererOptions) {
    this.#options = options;
    this.#texts = options.texts;
    this.#numbers = options.numbers;
    this.#codes = numberCodes(options.numbers);
  }

  async init(host: HTMLElement): Promise<RendererInfo> {
    const canvas = document.createElement('canvas');
    canvas.className = 'scene-canvas';
    this.#canvas = canvas;
    const app = new Application();
    this.#app = app;
    const size = this.#viewport?.viewport;
    await app.init({
      canvas,
      preference: [...this.#options.preference],
      background: PALETTE.cave0,
      antialias: false,
      autoDensity: true,
      resolution: renderResolution(this.#viewport?.pixelRatio ?? window.devicePixelRatio),
      width: Math.max(1, size?.width ?? host.clientWidth),
      height: Math.max(1, size?.height ?? host.clientHeight),
      autoStart: false,
    });
    this.#ready = true;
    const info = describeRenderer(app.renderer);
    const texts = this.#options.allTexts.flatMap(sceneTextList);
    const fontReady = (await ensureDigitsFont()) && (await ensureLabelsFont(texts));
    const atlas = new CrystalAtlas(app.renderer);
    const background = new CaveBackground();
    const frame = new FrameView(atlas);
    this.#root.addChild(frame.view);
    const round = new RoundView(atlas, this.#root, { texts: this.#texts, codes: this.#codes });
    this.#scene = { atlas, background, frame, round };
    app.stage.addChild(background.view, this.#root);
    this.#ambient.setReducedMotion(this.#reducedMotion);
    this.#applyViewport();
    this.#frame(0);
    if (this.#options.warmUp) {
      round.forWarmUp(() => {
        warmUp(app.renderer, app.stage, fontPages());
      });
    }
    host.appendChild(canvas);
    app.ticker.add(this.#tick);
    if (import.meta.env.DEV) {
      this.#marks = new FrameMarks();
      this.#marks.attach(app.ticker);
    }
    app.start();
    const inspector = this.#options.inspector;
    if (inspector !== null) {
      this.#inspected = {
        app,
        info,
        atlas,
        root: this.#root,
        fontReady,
        layout: () => this.#layout,
        settled: () => this.#source?.finished === true && round.settled,
        step: (deltaMs) => {
          this.#frame(deltaMs);
        },
        missingGlyphs: (asked) =>
          asked === null ? [...fontMissing(LABELS_FONT, texts), ...fontMissing(DIGITS_FONT, digitTexts(this.#numbers))] : fontMissing(LABELS_FONT, asked),
        chipRects: () => round.chipRects(),
        isolateChipParts: (lock, digits) => {
          round.isolateChipParts(lock, digits);
        },
        plaqueText: () => round.plaqueText(),
        labels: () => round.labels(),
        pinAmbient: (seconds) => {
          this.#ambient.pin(seconds);
          this.#applyAmbient();
        },
        backgroundOnly: (on) => {
          this.#root.visible = !on;
        },
      };
      inspector.attach(this.#inspected);
    }
    return info;
  }

  resize(viewport: Viewport, pixelRatio: number): void {
    this.#viewport = { viewport, pixelRatio };
    this.#applyViewport();
  }

  /** Сразу встаёт только время фона (решение 1): частицы и падение раунда — по его расписанию, со следующего раунда. */
  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
    this.#ambient.setReducedMotion(on);
    this.#applyAmbient();
  }

  setSource(source: SceneSource | null): void {
    this.#source = source;
  }

  setLanguage(texts: SceneTexts, numbers: NumberStyle): void {
    this.#texts = texts;
    this.#numbers = numbers;
    this.#codes = numberCodes(numbers);
    this.#scene?.round.setWords(texts, this.#codes);
  }

  /**
   * Иконки символов — кадры атласа через временный спрайт: extract самой текстуры-кадра на WebGPU копирует весь атлас
   * (GpuTextureSystem.generateCanvas не читает frame), а спрайт проходит generateTexture по своим границам на обоих.
   */
  symbolIcons(): Promise<readonly string[] | null> {
    const app = this.#app;
    const scene = this.#scene;
    if (app === null || scene === null) return Promise.resolve(null);
    this.#icons ??= Promise.all(
      Array.from({ length: SYMBOL_COUNT }, (_, id) => {
        const sprite = new Sprite(scene.atlas.texture(symbolKey(id as SymbolId)));
        // Кадр рисуется синхронно в самом вызове: спрайт можно убрать сразу, PNG кодируется уже без него.
        const url = app.renderer.extract.base64({ target: sprite, resolution: ATLAS_RESOLUTION });
        sprite.destroy();
        return url;
      }),
    );
    return this.#icons;
  }

  /** Безопасен в любом состоянии: и после неудачного init, и повторно. */
  destroy(): void {
    if (this.#inspected !== null) {
      this.#options.inspector?.detach(this.#inspected);
      this.#inspected = null;
    }
    const app = this.#app;
    const scene = this.#scene;
    if (app !== null && this.#ready) {
      app.ticker.remove(this.#tick);
      this.#marks?.detach(app.ticker);
      this.#marks = null;
      if (scene !== null) {
        scene.round.destroy();
        scene.frame.destroy();
        scene.background.destroy();
        scene.atlas.destroy();
      }
      app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    }
    this.#canvas?.remove();
    this.#app = null;
    this.#canvas = null;
    this.#ready = false;
    this.#scene = null;
    this.#icons = null;
  }

  /** Кадр: часы источника на deltaMs (целые мс от часов кадра), его SceneState — на сцену; тепло фриспинов — фону и рамке. */
  #frame(deltaMs: number): void {
    const scene = this.#scene;
    if (scene === null) return;
    const source = this.#source;
    let target = 0;
    if (source !== null) {
      const state = source.tick(deltaMs);
      scene.round.apply(state, source.schedule);
      target = state.freeSpinsLeft >= 0 ? 1 : 0;
    }
    const step = this.#reducedMotion ? 1 : Math.min(1, deltaMs / WARMTH_MS);
    this.#warmth += Math.max(-step, Math.min(step, target - this.#warmth));
    this.#applyAmbient();
  }

  #applyAmbient(): void {
    const scene = this.#scene;
    if (scene === null) return;
    const seconds = this.#ambient.seconds;
    scene.background.update(seconds, this.#warmth);
    scene.frame.update(seconds);
    scene.frame.setWarmth(this.#warmth);
  }

  #applyViewport(): void {
    const app = this.#app;
    const state = this.#viewport;
    const scene = this.#scene;
    if (app === null || !this.#ready || state === null || scene === null) return;
    const layout = computeLayout(state.viewport);
    this.#layout = layout;
    app.renderer.resize(Math.max(1, state.viewport.width), Math.max(1, state.viewport.height), renderResolution(state.pixelRatio));
    this.#root.position.set(layout.stage.x, layout.stage.y);
    this.#root.scale.set(layout.scale);
    scene.background.layout(layout);
    scene.frame.setDesign(layout.design);
    scene.round.setDesign(layout.design);
  }
}
