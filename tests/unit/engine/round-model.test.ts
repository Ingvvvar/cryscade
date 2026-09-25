import { describe, expect, it } from 'vitest';
import { EventRecorder } from '../../../src/core/engine/index.ts';
import type { RoundEvent } from '../../../src/core/model/events.ts';
import { STRESS_CONFIG } from '../../support/configs.ts';
import { ModelMismatch, verifyRound, type RoundFacts } from '../../support/round-model.ts';
import { GuardedRounds } from '../../support/watchdog.ts';

// Положительный контроль эталонной модели: модели верят, только если она ловит испорченные события.
// Раунд-образец — первый сид стресс-конфига, где есть всё: каскад, множитель, фича, ретриггер и кап.

function findSample(): { seed: number; events: readonly RoundEvent[]; facts: RoundFacts } {
  const recorder = new EventRecorder();
  const rounds = new GuardedRounds(STRESS_CONFIG, recorder);
  for (let seed = 0; seed < 100_000; seed++) {
    rounds.play(seed);
    const facts = verifyRound(STRESS_CONFIG, recorder.events);
    if (facts.featured && facts.retriggers > 0 && facts.capped && facts.longestCascade >= 2 && facts.topLevel >= 2) {
      return { seed, events: recorder.events, facts };
    }
  }
  throw new Error('образец не найден');
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type Event = Mutable<RoundEvent>;
type Of<T extends RoundEvent['t']> = Extract<Event, { t: T }>;

// Ищется лениво, внутри тестов: расхождение модели с движком — упавший тест с сообщением, а не упавший файл.
let found: ReturnType<typeof findSample> | null = null;
function sample(): ReturnType<typeof findSample> {
  found ??= findSample();
  return found;
}

function corrupt(change: (events: Event[]) => void): Event[] {
  const events = structuredClone(sample().events) as Event[];
  change(events);
  return events;
}

function first<T extends RoundEvent['t']>(events: Event[], t: T, where: (event: Of<T>) => boolean = () => true): Of<T> {
  const found = events.find((event): event is Of<T> => event.t === t && where(event as Of<T>));
  if (found === undefined) throw new Error(`в образце нет события ${t}`);
  return found;
}

const index = (events: Event[], t: RoundEvent['t']): number => events.findIndex((event) => event.t === t);

function at<T>(list: T[], position: number): T {
  const item = list[position];
  if (item === undefined) throw new Error(`в образце нет элемента ${String(position)}`);
  return item;
}

describe('эталонная модель', () => {
  it('образец настоящий и модель его принимает', () => {
    const { facts } = sample();
    expect(facts.featured).toBe(true);
    expect(facts.retriggers).toBeGreaterThan(0);
    expect(facts.capped).toBe(true);
    expect(facts.payX100).toBe(STRESS_CONFIG.capX100);
  });

  it.each<[string, (events: Event[]) => void]>([
    ['fill: символ 8', (e) => (first(e, 'fill').grid[0] = 8)],
    ['win: выплата +1', (e) => (at(first(e, 'win').clusters, 0).payX100 += 1)],
    ['win: множитель +1', (e) => (at(first(e, 'win', (w) => (w.clusters[0]?.mult ?? 1) > 1).clusters, 0).mult += 1)],
    ['win: клетка кластера пропала', (e) => at(first(e, 'win').clusters, 0).cells.pop()],
    ['win: чужой символ кластера', (e) => (at(first(e, 'win').clusters, 0).symbol = 7)],
    ['win: лишний кластер', (e) => first(e, 'win').clusters.push({ symbol: 0, cells: [0, 1, 2, 3, 4], payX100: 20, mult: 1 })],
    ['explode: клетка пропала', (e) => first(e, 'explode').cells.pop()],
    ['spots: уровень +1', (e) => (first(e, 'spots', (s) => s.levels.length > 0).levels[0] = at(first(e, 'spots', (s) => s.levels.length > 0).levels, 0) + 1)],
    ['refill: ход не туда', (e) => (at(first(e, 'refill', (r) => r.moves.length > 0).moves, 0)[1] += 7)],
    ['refill: досыпка не в ту клетку', (e) => (at(first(e, 'refill').drops, 0).cell += 1)],
    ['refill: досыпан не символ', (e) => (at(first(e, 'refill').drops, 0).symbol = 8)],
    ['scatters: ядро пропало', (e) => first(e, 'scatters').cells.pop()],
    ['fsStart: спинов на один больше', (e) => (first(e, 'fsStart').spins += 1)],
    ['fsSpin: остаток на один больше', (e) => (first(e, 'fsSpin').left += 1)],
    ['fsRetrigger: +6 вместо +5', (e) => (first(e, 'fsRetrigger').add += 1)],
    ['cap пропал', (e) => e.splice(index(e, 'cap'), 1)],
    ['end: итог +1', (e) => (first(e, 'end').payX100 += 1)],
    ['событие после end', (e) => e.push({ t: 'cap' })],
    ['explode раньше win', (e) => {
      const position = index(e, 'win');
      const win = at(e, position);
      e[position] = at(e, position + 1);
      e[position + 1] = win;
    }],
  ])('%s — ModelMismatch', (_name, change) => {
    expect(() => verifyRound(STRESS_CONFIG, corrupt(change))).toThrow(ModelMismatch);
  });
});
