import { describe, expect, it } from 'vitest';
import type { ClockListener } from '../../../src/client/index.ts';
import { SoundGate, type SoundGateOptions, type SoundSink } from '../../../src/ui/sound-gate.ts';

// Звук по первому жесту (§12, решения 1 и 5 фазы 8): до жеста контекста нет; первый pointerdown или keydown — контекст
// в том же жесте, модуль звука — после; часы показа слушают звук, мьют — из настройки, скрытая вкладка — пауза.

class Target {
  readonly listeners = new Map<string, () => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener === 'function') this.listeners.set(type, listener as () => void);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  fire(type: string): void {
    this.listeners.get(type)?.();
  }
}

class Source<T> {
  readonly #listeners = new Set<() => void>();
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  getSnapshot(): T {
    return this.value;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(value: T): void {
    this.value = value;
    for (const listener of [...this.#listeners]) listener();
  }
}

class Sink implements SoundSink {
  readonly log: string[] = [];

  started(): void {
    this.log.push('started');
  }

  advanced(): void {
    this.log.push('advanced');
  }

  setMuted(on: boolean): void {
    this.log.push(`muted ${String(on)}`);
  }

  setHidden(on: boolean): void {
    this.log.push(`hidden ${String(on)}`);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rig(overrides: Partial<SoundGateOptions> = {}) {
  const target = new Target();
  const contexts: object[] = [];
  const sink = new Sink();
  const observed: (ClockListener | null)[] = [];
  const enabled = new Source(true);
  const hidden = new Source(false);
  let loads = 0;
  const gate = new SoundGate({
    target,
    createContext: () => {
      const context = {};
      contexts.push(context);
      return context as AudioContext;
    },
    load: () => {
      loads += 1;
      return Promise.resolve(sink);
    },
    clock: {
      observe: (listener) => {
        observed.push(listener);
      },
    },
    enabled,
    hidden,
    ...overrides,
  });
  return { gate, target, contexts, sink, observed, enabled, hidden, loads: () => loads };
}

describe('SoundGate', () => {
  it('до жеста — ни контекста, ни загрузки; первый pointerdown — контекст сразу, звук — после загрузки', async () => {
    const { gate, target, contexts, sink, observed, loads } = rig();
    gate.arm();
    await flush();
    expect([contexts.length, loads(), gate.ready]).toStrictEqual([0, 0, false]);
    target.fire('pointerdown');
    expect([contexts.length, loads()]).toStrictEqual([1, 1]);
    await flush();
    expect([gate.ready, observed, sink.log]).toStrictEqual([true, [sink], ['muted false', 'hidden false']]);
    target.fire('keydown');
    target.fire('pointerdown');
    expect([contexts.length, loads(), target.listeners.size]).toStrictEqual([1, 1, 0]);
  });

  it('клавиша — тоже жест; мьют и скрытая вкладка — из источников, сразу и при смене', async () => {
    const { gate, target, sink, enabled, hidden } = rig();
    enabled.set(false);
    hidden.set(true);
    gate.arm();
    target.fire('keydown');
    await flush();
    expect(sink.log).toStrictEqual(['muted true', 'hidden true']);
    enabled.set(true);
    hidden.set(false);
    expect(sink.log).toStrictEqual(['muted true', 'hidden true', 'muted false', 'hidden false']);
  });

  it('WebAudio нет или модуль не загрузился — без звука и без исключений', async () => {
    const none = rig({ createContext: () => null });
    none.gate.arm();
    none.target.fire('pointerdown');
    await flush();
    expect([none.loads(), none.gate.ready, none.observed]).toStrictEqual([0, false, []]);
    const broken = rig({ load: () => Promise.reject(new Error('chunk')) });
    broken.gate.arm();
    broken.target.fire('pointerdown');
    await flush();
    expect([broken.gate.ready, broken.observed]).toStrictEqual([false, []]);
  });

  it('arm дважды — одна пара слушателей', () => {
    const { gate, target } = rig();
    gate.arm();
    gate.arm();
    expect([...target.listeners.keys()]).toStrictEqual(['pointerdown', 'keydown']);
  });
});
