import { describe, expect, it } from 'vitest';
import { PROBE_CHANNEL, checkForceRound, checkForceRoundAck, checkMemoryLeak } from '../../../src/protocol/index.ts';

// Канал зонда (dev и e2e): воркер принимает только forceRound с сидом uint32, остальное — не его сообщение.

describe('checkForceRound', () => {
  it('канал — свой, не канал вкладок', () => {
    expect(PROBE_CHANNEL).toBe('cryscade-probe');
  });

  it.each([0, 48, 4_294_967_295])('сид %d — годен', (seed) => {
    expect(checkForceRound({ type: 'forceRound', seed })).toBeNull();
  });

  it.each([
    ['сид −1', { type: 'forceRound', seed: -1 }],
    ['дробный сид', { type: 'forceRound', seed: 1.5 }],
    ['сид 2^32', { type: 'forceRound', seed: 4_294_967_296 }],
    ['сид строкой', { type: 'forceRound', seed: '48' }],
    ['без сида', { type: 'forceRound' }],
    ['чужой тип', { type: 'walletChanged', seed: 48 }],
    ['null', null],
    ['массив', [48]],
  ])('%s — не годен', (_, value) => {
    expect(checkForceRound(value)).toEqual(expect.any(String));
  });

  it('ответ воркера — свой тип: forceRound за ответ не принимается, и наоборот', () => {
    expect(checkForceRoundAck({ type: 'forceRoundAck', seed: 48 })).toBeNull();
    expect(checkForceRoundAck({ type: 'forceRound', seed: 48 })).toEqual(expect.any(String));
    expect(checkForceRound({ type: 'forceRoundAck', seed: 48 })).toEqual(expect.any(String));
    expect(checkForceRoundAck({ type: 'forceRoundAck', seed: -1 })).toEqual(expect.any(String));
  });
});

// Положительный контроль замера памяти (§13, фаза 9): воркер держит объект на каждое memoryLeak — только этот тип.
describe('checkMemoryLeak', () => {
  it('memoryLeak — годен', () => {
    expect(checkMemoryLeak({ type: 'memoryLeak' })).toBeNull();
  });

  it.each([
    ['forceRound', { type: 'forceRound', seed: 48 }],
    ['чужой тип', { type: 'memoryLeakAck' }],
    ['без типа', {}],
    ['null', null],
    ['строка', 'memoryLeak'],
  ])('%s — не memoryLeak', (_, value) => {
    expect(checkMemoryLeak(value)).toEqual(expect.any(String));
  });

  it('forceRound и memoryLeak не путаются', () => {
    expect(checkForceRound({ type: 'memoryLeak' })).toEqual(expect.any(String));
  });
});
