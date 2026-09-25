import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SilentRecorder, type SymbolSource } from '../../../src/core/engine/index.ts';
import { SUPERCRITICAL_CONFIG } from '../../support/configs.ts';
import { GuardedRounds, WatchdogError, WatchdogSource } from '../../support/watchdog.ts';

const constant: SymbolSource = { next: () => 0 };

describe('WatchdogSource', () => {
  it('пропускает limit запросов и роняет следующий с сидом раунда', () => {
    const watchdog = new WatchdogSource(constant, 3);
    watchdog.arm(4242);
    for (let request = 0; request < 3; request++) expect(watchdog.next('base', request)).toBe(0);
    expect(() => watchdog.next('base', 3)).toThrow(WatchdogError);
    expect(() => watchdog.next('base', 3)).toThrow(/сидом 4242 сделал больше 3 запросов/);
  });

  it('arm начинает счёт раунда с нуля', () => {
    const watchdog = new WatchdogSource(constant, 3);
    watchdog.arm(1);
    for (let request = 0; request < 3; request++) watchdog.next('base', request);
    watchdog.arm(2);
    for (let request = 0; request < 3; request++) expect(watchdog.next('free', request)).toBe(0);
    expect(watchdog.requests).toBe(3);
  });
});

// Положительный контроль сторожа: ретриггер почти на каждом фриспине, кап недостижим. Без сторожа такой раунд
// висел бы; со сторожем — красный тест с сидом.
describe('надкритичный конфиг даёт красный тест, а не висящий процесс', () => {
  it('раунд падает WatchdogError с сидом', () => {
    const rounds = new GuardedRounds(SUPERCRITICAL_CONFIG, new SilentRecorder());
    expect(() => rounds.play(12345)).toThrow(/сидом 12345 сделал больше 100000 запросов/);
  });

  it('property-тест падает: сид fast-check — в сообщении, сид раунда — в причине', () => {
    const rounds = new GuardedRounds(SUPERCRITICAL_CONFIG, new SilentRecorder());
    let failure: unknown = null;
    try {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
          rounds.play(seed);
        }),
        { numRuns: 20, seed: 7 },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const { message, cause } = failure as Error;
    expect(message).toMatch(/seed: 7,/);
    expect(cause).toBeInstanceOf(WatchdogError);
    expect((cause as Error).message).toMatch(/сидом \d+ сделал больше 100000 запросов/);
  });
});
