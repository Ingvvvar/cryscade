// Фасад рендера (§3, §10). Канвас — поколения рендерера: создаётся здесь и уничтожается с removeView: true.
// React владеет только хост-элементом: WebGL-destroy теряет контекст канваса, и новый init на том же канвасе
// вешает страницу (проба на Pixi 8.21). Свои части — атлас, фон, рамку, показ раунда — рендерер создаёт сам.
// Кадр рендер тянет сам: тикер двигает часы источника (SceneSource) и ставит его SceneState — рендер ничего не решает.
// Порядок init: приложение → шрифты → атлас → сцена → прогрев → канвас в DOM → тикер.
// Эконом-режим (§10) — на программном рендерере: фон и декор стоят, как при reduced motion, разрешение 1×, кадр рисуется,
// только когда изменился (RenderGate). На GPU render Pixi остаётся на тикере, как его повесил TickerPlugin.

import {
  Application,
  Container,
  Sprite,
  UPDATE_PRIORITY,
  type Renderer as PixiRendererBackend,
  type Ticker,
  type TickerCallback,
  type WebGLRenderer,
  type WebGPURenderer,
} from 'pixi.js';
import { SYMBOL_COUNT, type SymbolId } from '../../core/model/symbols.ts';
import { AmbientClock } from '../ambient-clock.ts';
import { ATLAS_RESOLUTION, symbolKey } from '../art/atlas-plan.ts';
import { PALETTE } from '../art/palette.ts';
import { FrameClock } from '../frame-clock.ts';
import { computeLayout, renderResolution, type Layout, type Viewport } from '../layout.ts';
import { numberCodes, type NumberCodes, type NumberStyle } from '../number-layout.ts';
import { RenderGate } from '../render-gate.ts';
import { sceneTextList, type Renderer, type RendererInfo, type RendererName, type SceneSource, type SceneTexts } from '../renderer.ts';
import { isSoftwareRenderer } from '../software-renderer.ts';
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
  /** Эконом-режим разрешён: включится на программном рендерере. Выключает только зонд — контроль его проверки. */
  readonly economy: boolean;
}

/** Тепло фриспинов (§9) набирается и уходит за столько миллисекунд; при reduced motion и в эконом-режиме — сразу. */
const WARMTH_MS = 600;

/** Что рендерер узнаёт о себе сам; эконом-режим решает PixiRenderer. */
type Detected = Omit<RendererInfo, 'economy'>;

function describeRenderer(renderer: PixiRendererBackend): Detected {
  if (renderer.name === 'webgpu') {
    const info = (renderer as WebGPURenderer).gpu.adapter.info;
    const gpu = [info.vendor, info.architecture, info.device, info.description].filter((part) => part !== '').join(' ');
    return { name: 'webgpu', gpu, software: info.isFallbackAdapter || isSoftwareRenderer(gpu) };
  }
  if (renderer.name === 'webgl') {
    const gl = (renderer as WebGLRenderer).gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const value: unknown = debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    const gpu = String(value);
    return { name: 'webgl', gpu, software: isSoftwareRenderer(gpu) };
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
  /** Эконом-режим (§10): программный рендерер, и зонд его не выключил. */
  #economy = false;
  /** Отрисовка через ворота: эконом-режим или порог зонда; на GPU без порога — null, render Pixi на тикере как есть. */
  #gate: RenderGate | null = null;
  /** Из чего был собран прошлый кадр: изменилось что-то — воротам пора рисовать. */
  #seenSource: SceneSource | null = null;
  #seenSchedule: SceneSource['schedule'] = null;
  #seenClock = Number.NaN;
  #seenAmbient = Number.NaN;
  #seenWarmth = Number.NaN;
  readonly #draw = (ticker: Ticker): void => {
    if (this.#gate?.frame(ticker.elapsedMS) === true) this.#app?.render();
  };
  /** Ввод по сцене — кадр в эконом-режиме, даже если показ на него не ответил. */
  readonly #onInput = (): void => {
    this.#gate?.invalidate();
  };

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
    const detected = describeRenderer(app.renderer);
    this.#economy = this.#options.economy && detected.software;
    const info: RendererInfo = { ...detected, economy: this.#economy };
    if (this.#economy) app.renderer.resize(app.screen.width, app.screen.height, 1);
    const texts = this.#options.allTexts.flatMap(sceneTextList);
    const fontReady = (await ensureDigitsFont()) && (await ensureLabelsFont(texts));
    const atlas = new CrystalAtlas(app.renderer);
    const background = new CaveBackground();
    const frame = new FrameView(atlas);
    this.#root.addChild(frame.view);
    const round = new RoundView(atlas, this.#root, { texts: this.#texts, codes: this.#codes });
    this.#scene = { atlas, background, frame, round };
    app.stage.addChild(background.view, this.#root);
    this.#ambient.setReducedMotion(this.#still);
    this.#applyViewport();
    this.#frame(0);
    if (this.#options.warmUp) {
      round.forWarmUp(() => {
        warmUp(app.renderer, app.stage, fontPages());
      });
    }
    host.appendChild(canvas);
    app.ticker.add(this.#tick);
    if (this.#economy) {
      this.#gateRenders(app, true);
      canvas.addEventListener('pointerdown', this.#onInput);
    }
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
          this.#gate?.invalidate();
        },
        plaqueText: () => round.plaqueText(),
        labels: () => round.labels(),
        pinAmbient: (seconds) => {
          this.#ambient.pin(seconds);
          this.#applyAmbient();
          this.#gate?.invalidate();
        },
        backgroundOnly: (on) => {
          this.#root.visible = !on;
          this.#gate?.invalidate();
        },
        throttle: (ms) => {
          (this.#gate ?? this.#gateRenders(app, false)).throttle(ms);
        },
        invalidate: () => {
          this.#gate?.invalidate();
        },
        ambient: () => this.#ambient.seconds,
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
    this.#ambient.setReducedMotion(this.#still);
    this.#applyAmbient();
    this.#gate?.invalidate();
  }

  setSource(source: SceneSource | null): void {
    this.#source = source;
    this.#gate?.invalidate();
  }

  setLanguage(texts: SceneTexts, numbers: NumberStyle): void {
    this.#texts = texts;
    this.#numbers = numbers;
    this.#codes = numberCodes(numbers);
    this.#scene?.round.setWords(texts, this.#codes);
    this.#gate?.invalidate();
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
      app.ticker.remove(this.#draw);
      this.#canvas?.removeEventListener('pointerdown', this.#onInput);
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
    this.#gate = null;
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
    const step = this.#still ? 1 : Math.min(1, deltaMs / WARMTH_MS);
    this.#warmth += Math.max(-step, Math.min(step, target - this.#warmth));
    this.#applyAmbient();
    this.#noteFrame(source);
  }

  /** Фон и декор стоят: reduced motion игрока или эконом-режим. */
  get #still(): boolean {
    return this.#reducedMotion || this.#economy;
  }

  /**
   * Кадр — функция расписания и времени показа (sampleScene), времени декора и тепла фриспинов: изменилось что-то из них
   * с прошлого тика — воротам пора рисовать. Ресайз, язык и прочее зовут invalidate сами.
   */
  #noteFrame(source: SceneSource | null): void {
    const schedule = source?.schedule ?? null;
    const clock = source?.clock ?? 0;
    const ambient = this.#ambient.seconds;
    if (source === this.#seenSource && schedule === this.#seenSchedule && clock === this.#seenClock && ambient === this.#seenAmbient && this.#warmth === this.#seenWarmth) return;
    this.#seenSource = source;
    this.#seenSchedule = schedule;
    this.#seenClock = clock;
    this.#seenAmbient = ambient;
    this.#seenWarmth = this.#warmth;
    this.#gate?.invalidate();
  }

  /**
   * Отрисовка через ворота: render Pixi снят с тикера — TickerPlugin вешает его с контекстом приложения на LOW — и
   * зовётся с того же приоритета, когда ворота пускают. onDemand — эконом-режим; без него — порог зонда.
   */
  #gateRenders(app: Application, onDemand: boolean): RenderGate {
    const gate = new RenderGate(onDemand);
    const render: unknown = Reflect.get(app, 'render');
    if (typeof render !== 'function') throw new Error('у Application нет render');
    app.ticker.remove(render as TickerCallback<Application>, app);
    app.ticker.add(this.#draw, undefined, UPDATE_PRIORITY.LOW);
    this.#gate = gate;
    return gate;
  }

  /** Разрешение отрисовки: эконом-режим — 1×, иначе плотность экрана до предела. */
  #resolution(pixelRatio: number): number {
    return this.#economy ? 1 : renderResolution(pixelRatio);
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
    app.renderer.resize(Math.max(1, state.viewport.width), Math.max(1, state.viewport.height), this.#resolution(state.pixelRatio));
    this.#root.position.set(layout.stage.x, layout.stage.y);
    this.#root.scale.set(layout.scale);
    scene.background.layout(layout);
    scene.frame.setDesign(layout.design);
    scene.round.setDesign(layout.design);
    this.#gate?.invalidate();
  }
}
