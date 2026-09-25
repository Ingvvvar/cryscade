import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventRecorder, RoundEngine, SeededEngine, SilentRecorder, WatchdogSource } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG, type GameConfig } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';
import { STRESS_CONFIG, TEST_CONFIG } from '../support/configs.ts';
import { verifyRound, type RoundFacts } from '../support/round-model.ts';
import { StreamSource } from '../support/streams.ts';
import { WATCHDOG_LIMIT, guarded } from '../support/watchdog.ts';

// Property-тесты движка §14 и §15. Раунды — под сторожем: надкритичный конфиг даёт красный тест с сидом,
// а не висящий процесс. При падении fast-check печатает свой сид и сид раунда (контрпример).

const SEED = fc.integer({ min: 0, max: 0xffffffff });

const CONFIGS: readonly [string, GameConfig][] = [
  ['стресс', STRESS_CONFIG],
  ['игра', DEFAULT_CONFIG],
];

function endOf(events: readonly RoundEvent[]): number | null {
  const last = events.at(-1);
  return last?.t === 'end' ? last.payX100 : null;
}

describe.each(CONFIGS)('конфиг «%s»', (name, config) => {
  it('каждый раунд сходится с эталонной моделью: сетка полна, взорвано = досыпано, кап, грамматика, выплаты, точки, фриспины', () => {
    const recorder = new EventRecorder();
    const rounds = guarded(config, recorder);
    const seen = { wins: 0, features: 0, freeSpins: 0, retriggers: 0, caps: 0, cascades3: 0 };
    fc.assert(
      fc.property(SEED, (seed) => {
        const payX100 = rounds.play(seed);
        const facts = verifyRound(config, recorder.events);
        expect(facts.payX100).toBe(payX100);
        expect(payX100).toBeLessThanOrEqual(config.capX100);
        if (payX100 > 0) seen.wins += 1;
        if (facts.featured) seen.features += 1;
        if (facts.capped) seen.caps += 1;
        if (facts.longestCascade >= 3) seen.cascades3 += 1;
        seen.freeSpins += facts.freeSpins;
        seen.retriggers += facts.retriggers;
      }),
      { numRuns: 1000 },
    );

    expect(seen.wins).toBeGreaterThan(0);
    if (name === 'стресс') {
      // Покрытие: прогон обязан пройти через фичу, ретриггер, кап и длинный каскад, иначе он проверил не всё.
      expect(seen.features).toBeGreaterThan(0);
      expect(seen.retriggers).toBeGreaterThan(0);
      expect(seen.caps).toBeGreaterThan(0);
      expect(seen.cascades3).toBeGreaterThan(0);
      // Фича стресс-конфига обязана кончаться: ретриггер заметно реже критических 0.2 (при +5 спинов).
      expect(seen.retriggers / seen.freeSpins).toBeLessThan(0.12);
    }
  });

  it('тихий и записывающий режимы: один итог и одинаковое число запросов к источнику', () => {
    const recorder = new EventRecorder();
    const recording = guarded(config, recorder);
    const silent = guarded(config, new SilentRecorder());
    fc.assert(
      fc.property(SEED, (seed) => {
        const quiet = silent.play(seed);
        const loud = recording.play(seed);
        expect(quiet).toBe(loud);
        expect(endOf(recorder.events)).toBe(loud);
        expect(silent.requests).toBe(recording.requests);
      }),
      { numRuns: 1000 },
    );
  });

  it('тихий и записывающий режимы на сидах 0…9999 дают один итог (§4.7)', () => {
    const recorder = new EventRecorder();
    const recording = guarded(config, recorder);
    const silent = guarded(config, new SilentRecorder());
    const mismatches: string[] = [];
    for (let seed = 0; seed < 10_000; seed++) {
      const quiet = silent.play(seed);
      const loud = recording.play(seed);
      if (quiet !== loud || endOf(recorder.events) !== loud) mismatches.push(`${String(seed)}: ${String(quiet)} ≠ ${String(loud)}`);
    }
    expect(mismatches).toStrictEqual([]);
  });

  it('один сид — побайтно одинаковые события: на свежем движке и после чужих раундов', () => {
    fc.assert(
      fc.property(SEED, fc.array(SEED, { maxLength: 4 }), (seed, before) => {
        const freshRecorder = new EventRecorder();
        guarded(config, freshRecorder).play(seed);
        const fresh = JSON.stringify(freshRecorder.events);

        const reusedRecorder = new EventRecorder();
        const reused = guarded(config, reusedRecorder);
        for (const other of before) reused.play(other);
        reused.play(seed);
        expect(JSON.stringify(reusedRecorder.events)).toBe(fresh);
      }),
      { numRuns: 300 },
    );
  });

  it('сторож не меняет поток: SeededEngine с порогом и без играет одни и те же раунды', () => {
    const seededRecorder = new EventRecorder();
    const seeded = new SeededEngine(config, seededRecorder);
    const guardedRecorder = new EventRecorder();
    const withWatchdog = guarded(config, guardedRecorder);
    fc.assert(
      fc.property(SEED, (seed) => {
        withWatchdog.play(seed);
        seeded.play(seed);
        expect(JSON.stringify(seededRecorder.events)).toBe(JSON.stringify(guardedRecorder.events));
      }),
      { numRuns: 300 },
    );
  });
});

// Редкие структуры, до которых ГСЧ с игровыми весами почти не доходит: символы — из потоков fast-check.
// Основной спин и фриспины — разные потоки. Во фриспинах ядро редкое, иначе фича надкритична.
// Номер прогона для сторожа — вместо сида; раунд воспроизводится по сиду fast-check.
const FREE_RARE_CORE = [...Array.from({ length: 42 }, (_, index) => index % 7), 7]; // ядро 1/43
const FREE_HEAVY = [...Array.from({ length: 59 }, (_, index) => [4, 5, 6, 4, 5, 6, 0, 1, 2, 3][index % 10] ?? 0), 7]; // ядро 1/60

function playStreams(config: GameConfig, base: Iterable<number>, free: Iterable<number>, run: number): RoundFacts {
  const recorder = new EventRecorder();
  const watchdog = new WatchdogSource(new StreamSource(base, free), WATCHDOG_LIMIT);
  watchdog.arm(run);
  const payX100 = new RoundEngine(config, watchdog, recorder).play();
  const facts = verifyRound(config, recorder.events);
  expect(facts.payX100).toBe(payX100);
  return facts;
}

describe('сгенерированный источник', () => {
  it('основной спин: группы из 5+ ядер, 7+ ядер, кап при трёх и больше ядрах — всё сходится с моделью', () => {
    // Основной спин — Бриллианты, Рубины и ядра: крупные кластеры и много ядер. Кап 5×, чтобы бить его в основном спине.
    const config: GameConfig = { ...TEST_CONFIG, capX100: 500 };
    const seen = { coreGroups5: 0, sevenCores: 0, baseCapWithCores: 0 };
    let run = 0;
    fc.assert(
      fc.property(fc.infiniteStream(fc.constantFrom(6, 6, 5, 7, 7)), fc.infiniteStream(fc.constantFrom(...FREE_RARE_CORE)), (base, free) => {
        run += 1;
        const facts = playStreams(config, base, free, run);
        if (facts.largestCoreGroup >= 5) seen.coreGroups5 += 1;
        if (facts.featured && facts.baseCores >= 7) seen.sevenCores += 1;
        if (facts.baseCapped && facts.baseCores >= 3) seen.baseCapWithCores += 1;
      }),
      { numRuns: 300 },
    );
    expect(seen.coreGroups5).toBeGreaterThan(0);
    expect(seen.sevenCores).toBeGreaterThan(0);
    expect(seen.baseCapWithCores).toBeGreaterThan(0);
  });

  it('длинные фичи: точки доходят до ×128 и дальше не растут — всё сходится с моделью', () => {
    // Во фриспинах три частых символа: длинные каскады по тем же клеткам. Кап недостижим, фича докритична.
    const config: GameConfig = { ...TEST_CONFIG, capX100: 10_000_000 };
    const seen = { topLevel: 0, freeSpins: 0, retriggers: 0 };
    let run = 0;
    fc.assert(
      fc.property(fc.infiniteStream(fc.constantFrom(4, 5, 6, 7, 7, 7)), fc.infiniteStream(fc.constantFrom(...FREE_HEAVY)), (base, free) => {
        run += 1;
        const facts = playStreams(config, base, free, run);
        if (facts.topLevel === 8) seen.topLevel += 1;
        seen.freeSpins += facts.freeSpins;
        seen.retriggers += facts.retriggers;
      }),
      { numRuns: 300 },
    );
    expect(seen.topLevel).toBeGreaterThan(0);
    expect(seen.retriggers / seen.freeSpins).toBeLessThan(0.12);
  });
});
