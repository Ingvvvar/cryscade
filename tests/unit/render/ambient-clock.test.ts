import { describe, expect, it } from 'vitest';
import { AMBIENT_PERIOD_S, AMBIENT_STILL_S, AmbientClock } from '../../../src/render/ambient-clock.ts';

describe('AmbientClock', () => {
  it('течёт от шагов тикера, в секундах', () => {
    const clock = new AmbientClock();
    expect(clock.seconds).toBe(0);
    clock.advance(250);
    clock.advance(500);
    expect(clock.seconds).toBe(0.75);
  });

  it('неположительный и нечисловой шаг время не двигает', () => {
    const clock = new AmbientClock();
    clock.advance(-16);
    clock.advance(Number.NaN);
    clock.advance(0);
    expect(clock.seconds).toBe(0);
  });

  it('заворачивается на периоде', () => {
    const clock = new AmbientClock();
    clock.advance(AMBIENT_PERIOD_S * 1000 + 1500);
    expect(clock.seconds).toBe(1.5);
  });

  it('reduced motion: стоит на заданном моменте и не копит время, после снятия идёт с того же места', () => {
    const clock = new AmbientClock();
    clock.advance(2000);
    clock.setReducedMotion(true);
    clock.advance(10_000);
    expect(clock.seconds).toBe(AMBIENT_STILL_S);
    clock.setReducedMotion(false);
    expect(clock.seconds).toBe(2);
  });

  it('закрепление старше reduced motion и хода; снятие возвращает ход', () => {
    const clock = new AmbientClock();
    clock.advance(1000);
    clock.pin(7.25);
    clock.advance(5000);
    clock.setReducedMotion(true);
    expect(clock.seconds).toBe(7.25);
    clock.setReducedMotion(false);
    clock.pin(null);
    expect(clock.seconds).toBe(6);
  });

  it('закрепить можно только конечное число', () => {
    const clock = new AmbientClock();
    expect(() => {
      clock.pin(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });
});
