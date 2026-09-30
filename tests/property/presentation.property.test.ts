import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventRecorder } from '../../src/core/engine/index.ts';
import { PRESETS } from '../../src/core/jurisdiction.ts';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import { SceneState, buildSchedule, finalGrid, sampleScene, type Schedule, type ScheduleOptions } from '../../src/core/presentation/index.ts';
import { STRESS_CONFIG } from '../support/configs.ts';
import { guarded } from '../support/watchdog.ts';

// Презентация §8.5 на раундах движка: в конце каждой группы каждая клетка занята ровно одним символом в покое;
// счётчик монотонен и кончается выигрышем; кадр в момент t не зависит от прежних вызовов; вспышек не больше трёх в
// секунду; конец показа — итоговая сетка. Стресс-конфиг — ради фич, капов и длинных каскадов.

const BETS = [20, 100, 1000, 10_000] as const;
/** Выигрыш своей формулой: floor(ставка × payX100 / 100) в BigInt, мимо winMinor. */
const ownWin = (bet: number, payX100: number): number => Number((BigInt(bet) * BigInt(payX100)) / 100n);

const OPTIONS: fc.Arbitrary<ScheduleOptions> = fc.record({
  speed: fc.constantFrom('normal' as const, 'turbo' as const),
  preset: fc.constantFrom(PRESETS.standard, PRESETS.strict),
  reducedMotion: fc.boolean(),
});

function atRest(out: SceneState): string | null {
  for (let cell = 0; cell < 49; cell++) {
    if (out.symbol[cell] === -1) return `клетка ${String(cell)} пуста`;
    if (out.offsetY[cell] !== 0 || out.alpha[cell] !== 1 || out.scale[cell] !== 1) return `клетка ${String(cell)} не в покое`;
    if (out.explode[cell] !== -1 || out.spotPop[cell] !== -1) return `клетка ${String(cell)} взрывается или вспыхивает`;
  }
  return null;
}

function snapshot(out: SceneState): unknown {
  return [
    [...out.symbol],
    [...out.offsetY],
    [...out.alpha],
    [...out.scale],
    [...out.highlight],
    [...out.explode],
    [...out.spotLevel],
    [...out.spotPop],
    out.contourStep,
    out.contourAlpha,
    out.counterMinor,
    out.freeSpinsLeft,
    out.freeSpinIndex,
    out.plaque,
    out.plaqueAlpha,
    out.plaqueValue,
    out.bigWinLevel,
    out.bigWinProgress,
    out.bigWinMinor,
    out.group,
    out.segment,
    out.settled,
  ];
}

function maxFlashesPerSecond(schedule: Schedule): number {
  const starts = schedule.segments.filter((segment) => segment.flash && segment.endMs > segment.startMs).map((segment) => segment.startMs);
  let worst = 0;
  for (const from of starts) worst = Math.max(worst, starts.filter((at) => at >= from && at < from + 1000).length);
  return worst;
}

describe.each([
  ['игры', DEFAULT_CONFIG],
  ['стресс', STRESS_CONFIG],
] as [string, GameConfig][])('раунды конфига «%s»', (name, config) => {
  it('покой в конце групп, счётчик, независимость кадра, вспышки, итоговая сетка', () => {
    const recorder = new EventRecorder();
    const rounds = guarded(config, recorder);
    const seen = { features: 0, caps: 0, strictSmall: 0, groups: 0 };
    fc.assert(
      fc.property(
        fc.nat(2 ** 32 - 1),
        fc.constantFrom(...BETS),
        OPTIONS,
        fc.boolean(),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 12 }),
        (seed, bet, options, withPrevious, fractions) => {
          const payX100 = rounds.play(seed);
          const events = [...recorder.events];
          const win = ownWin(bet, payX100);
          const previousGrid = withPrevious ? finalGrid(events) : null;
          const schedule = buildSchedule({ events, betMinor: bet, winMinor: win, previousGrid }, options);
          const out = new SceneState();
          // Конец каждой группы.
          for (const group of schedule.groups) {
            sampleScene(schedule, group.endMs, out);
            expect(atRest(out)).toBeNull();
          }
          // Конец показа — итоговая сетка раунда и выигрыш.
          sampleScene(schedule, schedule.durationMs, out);
          expect([...out.symbol]).toStrictEqual(finalGrid(events));
          expect(out.counterMinor).toBe(win);
          // Счётчик монотонен.
          let previous = -1;
          for (let k = 0; k <= 200; k++) {
            sampleScene(schedule, (schedule.durationMs * k) / 200, out);
            expect(out.counterMinor).toBeGreaterThanOrEqual(previous);
            previous = out.counterMinor;
          }
          // Кадр в момент t не зависит от прежних вызовов.
          const times = fractions.map((fraction) => fraction * schedule.durationMs);
          const shared = new SceneState();
          for (const t of times) {
            sampleScene(schedule, t, shared);
            const fresh = new SceneState();
            sampleScene(schedule, t, fresh);
            expect(snapshot(shared)).toStrictEqual(snapshot(fresh));
          }
          expect(maxFlashesPerSecond(schedule)).toBeLessThanOrEqual(3);
          // Единицы пропуска: номер растёт на 1 ровно на заполнении и на празднике, конец единицы — начало следующей.
          schedule.groups.forEach((group, k) => {
            const opens = k > 0 && (group.kind === 'fill' || group.kind === 'bigWin');
            expect(group.unit).toBe(k === 0 ? 0 : (schedule.groups[k - 1]?.unit ?? -1) + (opens ? 1 : 0));
            const next = schedule.groups[k + 1];
            if (next === undefined || next.unit !== group.unit) expect(schedule.unitEnds[group.unit]).toBe(group.endMs);
          });
          expect(schedule.unitEnds).toHaveLength((schedule.groups.at(-1)?.unit ?? -1) + 1);
          expect(schedule.unitEnds.at(-1)).toBe(schedule.durationMs);
          if (!options.preset.celebrateSmallWins && payX100 <= 100) {
            expect(schedule.segments.filter((segment) => segment.celebrate)).toStrictEqual([]);
            expect(schedule.durationMs).toBeGreaterThanOrEqual(2500);
            seen.strictSmall += 1;
          }
          if (schedule.holds.length > 0) seen.features += 1;
          if (schedule.bigWinLevel === 4) seen.caps += 1;
          seen.groups += schedule.groups.length;
        },
      ),
      { numRuns: name === 'стресс' ? 300 : 500 },
    );
    expect(seen.groups).toBeGreaterThan(0);
    expect(seen.strictSmall).toBeGreaterThan(0);
    if (name === 'стресс') {
      expect(seen.features).toBeGreaterThan(0);
      expect(seen.caps).toBeGreaterThan(0);
    }
  }, 120_000);
});
