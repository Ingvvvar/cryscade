import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutSleep } from '../../../src/client/index.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TimeoutSleep', () => {
  it('сбывается ровно через ms', async () => {
    let outcome: string | null = null;
    void new TimeoutSleep().sleep(250).then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('elapsed');
  });

  it('отмена — aborted сразу, таймер снят', async () => {
    const stop = new AbortController();
    const sleeping = new TimeoutSleep().sleep(3000, stop.signal);
    stop.abort();
    expect(await sleeping).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('уже отменённый сигнал — aborted без таймера', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await new TimeoutSleep().sleep(3000, stop.signal)).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });
});
