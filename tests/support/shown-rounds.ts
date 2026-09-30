import type { ShownRound } from '../../src/client/index.ts';
import { EventRecorder, SeededEngine } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';
import { CELL_COUNT } from '../../src/core/model/grid.ts';
import { winMinor } from '../../src/core/money.ts';
import { fixtureRound, type FixtureName } from './fixture-rounds.ts';

// Раунды для показа на сцене через зонд (still): записанные фикстуры и искусственные кадры точек. Простые данные —
// уходят в страницу через page.evaluate.

/** Раунд фикстуры, как его отдаёт сервер при ставке betMinor. */
export function fixtureShown(name: FixtureName, betMinor = 100): ShownRound {
  const round = fixtureRound(name);
  return { roundId: name, betMinor, winMinor: winMinor(betMinor, round.payX100), events: round.events };
}

/** Раунд сида на конфиге игры — тот же, что сервер разыграл бы на этом сиде (уровни большого выигрыша без фикстур). */
export function seedShown(seed: number, betMinor = 100): ShownRound {
  const recorder = new EventRecorder();
  const payX100 = new SeededEngine(DEFAULT_CONFIG, recorder, { maxRequests: 1_000_000 }).play(seed);
  return { roundId: `seed-${String(seed)}`, betMinor, winMinor: winMinor(betMinor, payX100), events: [...recorder.events] };
}

/**
 * Кадр точек: сетка grid и уровни точек levels (§4.7) на всех клетках. Не раунд движка — показ, который кончается ровно
 * этим полем: fill, один шаг каскада без выплаты, где spots ставит уровни, досыпка той же клетки, end без выигрыша.
 */
export function spotRound(grid: readonly number[], levels: readonly number[]): ShownRound {
  if (grid.length !== CELL_COUNT || levels.length !== CELL_COUNT) throw new RangeError('сетка и уровни — по 49 клеток');
  const cells = levels.flatMap((level, cell) => (level > 0 ? [cell] : []));
  const events: RoundEvent[] = [
    { t: 'fill', grid: [...grid] },
    { t: 'win', clusters: [{ symbol: grid[0] ?? 0, cells: [0], payX100: 0, mult: 1 }] },
    { t: 'explode', cells: [0] },
    { t: 'spots', cells, levels: cells.map((cell) => levels[cell] ?? 0) },
    { t: 'refill', moves: [], drops: [{ cell: 0, symbol: grid[0] ?? 0 }] },
    { t: 'end', payX100: 0 },
  ];
  return { roundId: 'spots', betMinor: 100, winMinor: 0, events };
}
