// Фасад рендера (§3, §10). Канвас — поколения рендерера: создаётся здесь и уничтожается с removeView: true.
// React владеет только хост-элементом: WebGL-destroy теряет контекст канваса, и новый init на том же канвасе
// вешает страницу (проба на Pixi 8.21). Свои части — атлас, фон, рамку, сетку, счётчик — рендерер создаёт сам.
// Порядок init: приложение → шрифт → атлас → сцена → прогрев → канвас в DOM → тикер.

import { Application, Container, type Renderer as PixiRendererBackend, type Ticker, type WebGLRenderer, type WebGPURenderer } from 'pixi.js';
import type { SymbolId } from '../../core/model/symbols.ts';
import { AmbientClock } from '../ambient-clock.ts';
import { PALETTE } from '../art/palette.ts';
import { computeLayout, renderResolution, type Layout, type Viewport } from '../layout.ts';
import type { Renderer, RendererInfo, RendererName } from '../renderer.ts';
import { CrystalAtlas } from './atlas.ts';
import { CaveBackground } from './background.ts';
import { FrameView } from './frame-view.ts';
import { GridView } from './grid-view.ts';
import type { InspectableScene, SceneInspector } from './scene-inspector.ts';
import { warmUp } from './warmup.ts';
import { WinCounter, ensureDigitsFont } from './win-counter.ts';

export interface PixiRendererOptions {
  /** Порядок попыток; рендерера вне списка не будет — принудительный ?renderer= не откатывается молча. */
  readonly preference: readonly RendererName[];
  /** Тестовый зонд; в проде — null. */
  readonly inspector: SceneInspector | null;
  /** Прогрев шейдеров до первого кадра; выключается только зондом — положительный контроль его проверки. */
  readonly warmUp: boolean;
}

const SOFTWARE = /swiftshader|llvmpipe|software/i;

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
  readonly grid: GridView;
  readonly counter: WinCounter;
}

export class PixiRenderer implements Renderer {
  readonly #options: PixiRendererOptions;
  readonly #root = new Container({ label: 'design' });
  readonly #ambient = new AmbientClock();
  readonly #tick = (ticker: Ticker): void => {
    this.#ambient.advance(ticker.deltaMS);
    this.#applyAmbient();
    this.#scene?.grid.update(ticker.deltaMS);
  };
  #app: Application | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #ready = false;
  #scene: Scene | null = null;
  #layout: Layout | null = null;
  #viewport: { readonly viewport: Viewport; readonly pixelRatio: number } | null = null;
  #reducedMotion = false;
  #pendingGrid: readonly SymbolId[] | null = null;
  #inspected: InspectableScene | null = null;

  constructor(options: PixiRendererOptions) {
    this.#options = options;
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
    const fontReady = await ensureDigitsFont();
    const atlas = new CrystalAtlas(app.renderer);
    const background = new CaveBackground();
    const frame = new FrameView(atlas);
    const grid = new GridView(atlas);
    this.#root.addChild(frame.view, grid.view);
    const counter = new WinCounter(this.#root);
    this.#scene = { atlas, background, frame, grid, counter };
    app.stage.addChild(background.view, this.#root);
    grid.setReducedMotion(this.#reducedMotion);
    this.#ambient.setReducedMotion(this.#reducedMotion);
    this.#applyViewport();
    this.#applyAmbient();
    if (this.#pendingGrid !== null) grid.show(this.#pendingGrid);
    if (this.#options.warmUp) warmUp(app.renderer, app.stage);
    host.appendChild(canvas);
    app.ticker.add(this.#tick);
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
        settled: () => grid.settled,
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

  setReducedMotion(on: boolean): void {
    this.#reducedMotion = on;
    this.#ambient.setReducedMotion(on);
    this.#scene?.grid.setReducedMotion(on);
    this.#applyAmbient();
  }

  showGrid(grid: readonly SymbolId[]): void {
    this.#pendingGrid = grid;
    this.#scene?.grid.show(grid);
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
      if (scene !== null) {
        scene.grid.destroy();
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
  }

  #applyAmbient(): void {
    const scene = this.#scene;
    if (scene === null) return;
    const seconds = this.#ambient.seconds;
    scene.background.update(seconds, 0);
    scene.frame.update(seconds);
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
    scene.grid.setDesign(layout.design);
    scene.counter.setDesign(layout.design);
  }
}
