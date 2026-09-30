// Показ раунда на сцене (§8.2, §9): всё, что ставит кадр SceneState, — сетка, подсветки, выигравшие символы, контуры,
// числа множителей, осколки и вспышки, счётчик, фриспины, плашки, большой выигрыш. Порядок слоёв — порядок отрисовки:
// аддитивное собрано подряд, чтобы не рвать батчи чаще нужного (§13: каскад ≤ 25 draw-call).

import { RenderLayer, type Container } from 'pixi.js';
import type { SceneState, Schedule } from '../../core/presentation/index.ts';
import type { ChipRect, Design } from '../layout.ts';
import type { NumberCodes } from '../number-layout.ts';
import type { SceneTexts } from '../renderer.ts';
import type { CrystalAtlas } from './atlas.ts';
import { BigWinView } from './big-win-view.ts';
import { ContourView } from './contour-view.ts';
import { FreeSpinsView, PlaqueView } from './feature-view.ts';
import { GridView } from './grid-view.ts';
import { HighlightView } from './highlight-view.ts';
import { ShardView } from './shard-view.ts';
import { SpotChips } from './spot-chips.ts';
import { WinCounter } from './win-counter.ts';

export interface RoundViewOptions {
  readonly texts: SceneTexts;
  readonly codes: NumberCodes;
}

export class RoundView {
  readonly #winners = new RenderLayer();
  readonly #grid: GridView;
  readonly #highlights: HighlightView;
  readonly #contours = new ContourView();
  readonly #chips: SpotChips;
  readonly #shards: ShardView;
  readonly #counter: WinCounter;
  readonly #freeSpins: FreeSpinsView;
  readonly #plaque: PlaqueView;
  readonly #bigWin: BigWinView;
  #settled = false;

  constructor(atlas: CrystalAtlas, parent: Container, options: RoundViewOptions) {
    this.#grid = new GridView(atlas, this.#winners);
    this.#highlights = new HighlightView(atlas);
    this.#chips = new SpotChips(atlas);
    this.#shards = new ShardView(atlas);
    this.#counter = new WinCounter(options.codes);
    this.#freeSpins = new FreeSpinsView(options.texts);
    this.#plaque = new PlaqueView(atlas, options.texts);
    this.#bigWin = new BigWinView(options.texts, options.codes);
    parent.addChild(
      this.#grid.view,
      this.#highlights.view,
      this.#winners,
      this.#contours.view,
      this.#chips.view,
      this.#shards.view,
      this.#shards.stars,
      this.#counter.view,
      this.#freeSpins.view,
      this.#plaque.view,
      this.#bigWin.view,
    );
  }

  setDesign(design: Design): void {
    this.#grid.setDesign(design);
    this.#contours.setDesign(design);
    this.#chips.place(this.#grid);
    this.#counter.setDesign(design);
    this.#freeSpins.setDesign(design);
    this.#plaque.setDesign(design);
    this.#bigWin.setDesign(design);
  }

  /**
   * Прогрев (§10): конвейеры частиц и аддитивных подсветок должны собраться до первого кадра, хотя в момент init на
   * сцене их нет. На время отрисовки прогрева осколки видимы и при reduced motion.
   */
  forWarmUp(render: () => void): void {
    this.#shards.forWarmUp(render);
  }

  /**
   * Кадр показа; schedule — чтобы раз на раунд построить контуры по его геометрии. Reduced motion — флаг расписания
   * раунда (§8.2, решение 1): переключённый посреди раунда, он убирает частицы и всплески только со следующего.
   */
  apply(scene: SceneState, schedule: Schedule | null): void {
    const still = schedule?.reducedMotion ?? false;
    this.#grid.apply(scene);
    this.#highlights.apply(scene, this.#grid);
    this.#contours.apply(scene, schedule);
    this.#chips.apply(scene);
    this.#shards.apply(scene, this.#grid, still);
    this.#counter.apply(scene.counterMinor);
    this.#freeSpins.apply(scene);
    this.#plaque.apply(scene, still);
    this.#bigWin.apply(scene, still);
    this.#settled = this.#grid.shown && scene.settled;
  }

  /** Надпись видимой плашки фичи; плашки нет — null. */
  plaqueText(): string | null {
    return this.#plaque.text;
  }

  /** Видимые плашки чисел множителей, CSS-пиксели канваса. */
  chipRects(): ChipRect[] {
    return this.#chips.rects();
  }

  /** На поле сетка, и в последнем кадре всё в покое. */
  get settled(): boolean {
    return this.#settled;
  }

  destroy(): void {
    this.#bigWin.destroy();
    this.#plaque.destroy();
    this.#freeSpins.destroy();
    this.#counter.destroy();
    this.#shards.destroy();
    this.#chips.destroy();
    this.#contours.destroy();
    this.#highlights.destroy();
    this.#grid.destroy();
    this.#winners.destroy();
  }
}
