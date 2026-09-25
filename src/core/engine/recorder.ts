import type { CellsView, ClusterView, GridView, RefillView, SpotsView } from './views.ts';

/**
 * Рекордер движка (Strategy): тихий и записывающий режимы — один код, разница только здесь.
 * Методы повторяют события §4.8. Ничего не возвращают и видят буферы только через виды —
 * поэтому на ход раунда рекордер не влияет.
 */
export interface RoundRecorder {
  begin(): void;
  fill(grid: GridView): void;
  win(clusters: ClusterView): void;
  explode(cells: CellsView): void;
  spots(spots: SpotsView): void;
  refill(refill: RefillView): void;
  scatters(cells: CellsView): void;
  fsStart(spins: number): void;
  fsSpin(index: number, left: number): void;
  fsRetrigger(add: number): void;
  cap(): void;
  end(payX100: number): void;
}

/** Тихий режим — только итог, для симуляции. Пустые методы V8 инлайнит в ничто. */
export class SilentRecorder implements RoundRecorder {
  begin(): void {}
  fill(): void {}
  win(): void {}
  explode(): void {}
  spots(): void {}
  refill(): void {}
  scatters(): void {}
  fsStart(): void {}
  fsSpin(): void {}
  fsRetrigger(): void {}
  cap(): void {}
  end(): void {}
}
