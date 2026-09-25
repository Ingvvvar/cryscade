import type { GameConfig } from '../../src/core/model/config.ts';

// Конфиг литеральных тестов движка — литерал здесь, а не DEFAULT_CONFIG: фаза 2 подбирает значения игры,
// а механику закрепляют эти. Таблица — черновик §4.4 в сотых долях. Веса сценариям не нужны:
// символы задаёт ScenarioSource.
export const TEST_CONFIG: GameConfig = {
  clusterMin: 5,
  sizeBands: [5, 7, 9, 11, 13, 15],
  paytableX100: [
    [20, 40, 80, 150, 300, 600],
    [25, 50, 100, 200, 400, 800],
    [30, 60, 120, 250, 500, 1000],
    [40, 80, 160, 300, 600, 1200],
    [60, 120, 250, 500, 1000, 2500],
    [80, 160, 350, 700, 1500, 4000],
    [100, 250, 500, 1000, 2500, 10000],
  ],
  weights: { base: [1, 1, 1, 1, 1, 1, 1, 1], free: [1, 1, 1, 1, 1, 1, 1, 1] },
  freeSpinsByScatters: [0, 0, 0, 10, 12, 15, 20],
  retrigger: { min: 3, add: 5 },
  capX100: 500_000,
};

export function withCap(capX100: number): GameConfig {
  return { ...TEST_CONFIG, capX100 };
}
