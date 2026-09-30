// Контуры кластеров (§8.4): многоугольники из расписания — геометрия считается при его сборке, здесь она только
// рисуется: по GraphicsContext на шаг каскада, раз на раунд, когда пришло новое расписание. В кадре Graphics лишь
// меняет контекст на шаг кадра и альфу. Контексты переиспользуются от раунда к раунду; координаты — от угла сетки.

import { Graphics, GraphicsContext } from 'pixi.js';
import type { SceneState, Schedule } from '../../core/presentation/index.ts';
import { PALETTE } from '../art/palette.ts';
import { CELL, type Design } from '../layout.ts';

/** Контур: чёткая линия и мягкий ореол, единицы дизайна. */
const LINE = 3;
const HALO = 9;

export class ContourView {
  readonly view = new Graphics({ label: 'contours', visible: false });
  readonly #contexts: GraphicsContext[] = [];
  readonly #empty = new GraphicsContext();
  #schedule: Schedule | null = null;
  #step = -1;

  setDesign(design: Design): void {
    this.view.position.set(design.zones.grid.x, design.zones.grid.y);
  }

  /** Кадр: контекст шага и альфа. Новое расписание — контуры всех шагов перерисовываются один раз. */
  apply(scene: SceneState, schedule: Schedule | null): void {
    if (schedule !== this.#schedule) this.#prepare(schedule);
    const step = scene.contourStep;
    if (step !== this.#step) {
      this.#step = step;
      this.view.context = step >= 0 ? (this.#contexts[step] ?? this.#empty) : this.#empty;
    }
    this.view.visible = step >= 0 && scene.contourAlpha > 0;
    this.view.alpha = scene.contourAlpha;
  }

  destroy(): void {
    this.view.destroy({ context: false });
    for (const context of this.#contexts) context.destroy();
    this.#empty.destroy();
  }

  #prepare(schedule: Schedule | null): void {
    this.#schedule = schedule;
    this.#step = -1;
    this.view.context = this.#empty;
    if (schedule === null) return;
    schedule.steps.forEach((step, index) => {
      let context = this.#contexts[index];
      if (context === undefined) {
        context = new GraphicsContext();
        // Контур со скруглёнными стыками — сотни вершин, и Pixi в режиме auto рисовал бы его своим конвейером графики
        // вне батча: лишний draw-call и конвейер, которого нет в прогреве (нашёл тест прогрева на кадрах каскада).
        context.batchMode = 'batch';
        this.#contexts.push(context);
      }
      context.clear();
      for (const cluster of step.clusters) {
        for (const ring of cluster.contour) {
          const points = Array.from(ring, (value) => value * CELL);
          context.poly(points, true).stroke({ width: HALO, color: PALETTE.glow, alpha: 0.22, join: 'round' });
          context.poly(points, true).stroke({ width: LINE, color: PALETTE.glow, alpha: 1, join: 'round' });
        }
      }
    });
  }
}
