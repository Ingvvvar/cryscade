import { GCProfiler, getHeapSpaceStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { FrameClock } from '../../../src/render/frame-clock.ts';

// Часы кадра (§8.2): дробное deltaMS тикера становится целыми миллисекундами в одном месте. Дрейфа нет — сумма целых
// отстаёт от суммы дельт меньше чем на миллисекунду. Аллокаций нет — тикер приходит ссылкой, дробное не пересекает
// вызовов, остаток живёт в Float64Array. Замер — рост нового пространства кучи между сборками, байт на кадр.

function sum(frames: number, deltaMS: number): number {
  const clock = new FrameClock();
  const ticker = { deltaMS };
  let total = 0;
  for (let k = 0; k < frames; k++) total += clock.advance(ticker);
  return total;
}

describe('FrameClock: без дрейфа', () => {
  it('600 кадров по 16.667 мс — 10 000 ± 1 мс; 1200 кадров по 8.333 мс — тоже', () => {
    expect(Math.abs(sum(600, 16.667) - 10_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(sum(1200, 8.333) - 10_000)).toBeLessThanOrEqual(1);
  });

  it('наружу — целые мс, остаток копится: три кадра по 0.4 мс — 0, 0, 1', () => {
    const clock = new FrameClock();
    const ticker = { deltaMS: 0.4 };
    expect([clock.advance(ticker), clock.advance(ticker), clock.advance(ticker)]).toStrictEqual([0, 0, 1]);
  });
});

function newSpaceUsed(): number {
  return getHeapSpaceStatistics().find((space) => space.space_name === 'new_space')?.space_used_size ?? Number.NaN;
}

/**
 * Байт нового пространства на кадр: прогон без единой сборки (иначе рост не виден), после прогрева JIT. Прогрев — не
 * меньше трёх серий и 250 мс: без оптимизирующего компилятора промежуточные дробные упаковываются в кучу (~65 Б на кадр
 * против ~1 Б), а три серии — около миллисекунды, и в холодном прогоне всего набора фоновый компилятор V8 за неё не успел.
 */
function bytesPerFrame(frame: () => void): number {
  const frames = 3000;
  const until = performance.now() + 250;
  for (let warm = 0; warm < 3 || performance.now() < until; warm++) for (let k = 0; k < frames; k++) frame();
  for (let attempt = 0; attempt < 20; attempt++) {
    const profiler = new GCProfiler();
    profiler.start();
    const before = newSpaceUsed();
    for (let k = 0; k < frames; k++) frame();
    const after = newSpaceUsed();
    if (profiler.stop().statistics.length === 0) return (after - before) / frames;
  }
  throw new Error('сборки мешают замеру');
}

describe('FrameClock: без аллокаций', () => {
  it.each([16.667, 8.333])('дробные дельты по %s мс — меньше 8 Б на кадр; контроль с объектом на кадр — больше 16', (deltaMS) => {
    const clock = new FrameClock();
    const ticker = { deltaMS };
    const sink: unknown[] = [0, 0];
    let total = 0;
    const quiet = bytesPerFrame(() => {
      total += clock.advance(ticker);
    });
    const control = bytesPerFrame(() => {
      total += clock.advance(ticker);
      sink[total & 1] = { total };
    });
    console.log(`часы кадра, дельта ${String(deltaMS)} мс: ${quiet.toFixed(1)} Б на кадр; контроль — ${control.toFixed(1)}`);
    expect(total).toBeGreaterThan(0);
    expect(control, 'положительный контроль: объект на кадр виден замеру').toBeGreaterThan(16);
    expect(quiet).toBeLessThan(8);
  });
});
