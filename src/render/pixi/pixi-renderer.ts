// Фасад рендера (§3, §10). Канвас — поколения рендерера: создаётся здесь и уничтожается с removeView: true.
// React владеет только хост-элементом: WebGL-destroy теряет контекст канваса, и новый init на том же канвасе
// вешает страницу (проба на Pixi 8.21). Свои части — атлас, сетку — рендерер создаёт сам.

import { Application, Container, type Renderer as PixiRendererBackend, type Ticker, type WebGLRenderer, type WebGPURenderer } from 'pixi.js';
import type { SymbolId } from '../../core/model/symbols.ts';
import { PALETTE } from '../art/palette.ts';
import { computeLayout, renderResolution, type Layout, type Viewport } from '../layout.ts';
import type { Renderer, RendererInfo, RendererName } from '../renderer.ts';
import { CrystalAtlas } from './atlas.ts';
import { GridView } from './grid-view.ts';
import type { InspectableScene, SceneInspector } from './scene-inspector.ts';

export interface PixiRendererOptions {
  /** Порядок попыток; рендерера вне списка не будет — принудительный ?renderer= не откатывается молча. */
  readonly preference: readonly RendererName[];
  /** Тестовый зонд; в проде — null. */
  readonly inspector: SceneInspector | null;
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

export class PixiRenderer implements Renderer {
  readonly #options: PixiRendererOptions;
  readonly #root = new Container({ label: 'design' });
  readonly #tick = (ticker: Ticker): void => {
    this.#grid?.update(ticker.deltaMS);
  };
  #app: Application | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #ready = false;
  #atlas: CrystalAtlas | null = null;
  #grid: GridView | null = null;
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
    const atlas = new CrystalAtlas(app.renderer);
    this.#atlas = atlas;
    const grid = new GridView(atlas);
    this.#grid = grid;
    grid.setReducedMotion(this.#reducedMotion);
    this.#root.addChild(grid.view);
    app.stage.addChild(this.#root);
    this.#applyViewport();
    if (this.#pendingGrid !== null) grid.show(this.#pendingGrid);
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
        layout: () => this.#layout,
        settled: () => grid.settled,
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
    this.#grid?.setReducedMotion(on);
  }

  showGrid(grid: readonly SymbolId[]): void {
    this.#pendingGrid = grid;
    this.#grid?.show(grid);
  }

  /** Безопасен в любом состоянии: и после неудачного init, и повторно. */
  destroy(): void {
    if (this.#inspected !== null) {
      this.#options.inspector?.detach(this.#inspected);
      this.#inspected = null;
    }
    const app = this.#app;
    if (app !== null && this.#ready) {
      app.ticker.remove(this.#tick);
      this.#grid?.destroy();
      this.#atlas?.destroy();
      app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    }
    this.#canvas?.remove();
    this.#app = null;
    this.#canvas = null;
    this.#ready = false;
    this.#grid = null;
    this.#atlas = null;
  }

  #applyViewport(): void {
    const app = this.#app;
    const state = this.#viewport;
    if (app === null || !this.#ready || state === null) return;
    const layout = computeLayout(state.viewport);
    this.#layout = layout;
    app.renderer.resize(Math.max(1, state.viewport.width), Math.max(1, state.viewport.height), renderResolution(state.pixelRatio));
    this.#root.position.set(layout.stage.x, layout.stage.y);
    this.#root.scale.set(layout.scale);
    this.#grid?.setDesign(layout.design);
  }
}
