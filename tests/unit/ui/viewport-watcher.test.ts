import { describe, expect, it } from 'vitest';
import type { Viewport } from '../../../src/render/layout.ts';
import type { ViewportSink } from '../../../src/render/renderer.ts';
import {
  REDUCED_MOTION_QUERY,
  ViewportWatcher,
  resolutionQuery,
  type MediaQueryListLike,
  type ScreenEnvironment,
  type ViewportSource,
} from '../../../src/ui/viewport-watcher.ts';

// Подставной matchMedia: запросы по строке, слушатели считаются, change вызывается вручную.
class FakeQuery implements MediaQueryListLike {
  readonly query: string;
  matches: boolean;
  readonly listeners = new Set<() => void>();

  constructor(query: string, matches: boolean) {
    this.query = query;
    this.matches = matches;
  }

  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }

  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeScreen implements ScreenEnvironment {
  devicePixelRatio = 1;
  reducedMotion = false;
  readonly queries: FakeQuery[] = [];

  matchMedia(query: string): FakeQuery {
    const matches = query === REDUCED_MOTION_QUERY ? this.reducedMotion : query === resolutionQuery(this.devicePixelRatio);
    const list = new FakeQuery(query, matches);
    this.queries.push(list);
    return list;
  }

  live(query: string): FakeQuery[] {
    return this.queries.filter((list) => list.query === query && list.listeners.size > 0);
  }
}

class FakeSource implements ViewportSource {
  viewport: Viewport = { width: 800, height: 600, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
  readonly listeners = new Set<() => void>();

  read(): Viewport {
    return this.viewport;
  }

  observe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class RecordingSink implements ViewportSink {
  readonly resizes: { width: number; pixelRatio: number }[] = [];
  readonly motion: boolean[] = [];

  resize(viewport: Viewport, pixelRatio: number): void {
    this.resizes.push({ width: viewport.width, pixelRatio });
  }

  setReducedMotion(on: boolean): void {
    this.motion.push(on);
  }
}

function setup(): { screen: FakeScreen; source: FakeSource; sink: RecordingSink; watcher: ViewportWatcher } {
  const screen = new FakeScreen();
  const source = new FakeSource();
  const sink = new RecordingSink();
  return { screen, source, sink, watcher: new ViewportWatcher(screen, source, sink) };
}

describe('ViewportWatcher', () => {
  it('на старте отдаёт размер, DPR и reduced motion', () => {
    const { screen, sink, watcher } = setup();
    screen.devicePixelRatio = 3;
    screen.reducedMotion = true;
    watcher.start();
    expect(sink.resizes).toStrictEqual([{ width: 800, pixelRatio: 3 }]);
    expect(sink.motion).toStrictEqual([true]);
  });

  it('размер хоста изменился — новый вьюпорт', () => {
    const { source, sink, watcher } = setup();
    watcher.start();
    source.viewport = { ...source.viewport, width: 390 };
    for (const listener of source.listeners) listener();
    expect(sink.resizes.at(-1)).toStrictEqual({ width: 390, pixelRatio: 1 });
  });

  it('перенос окна на другой монитор: смена DPR без смены размера доходит до рендерера', () => {
    const { screen, sink, watcher } = setup();
    watcher.start();
    const [first] = screen.live(resolutionQuery(1));
    expect(first).toBeDefined();
    screen.devicePixelRatio = 2;
    first?.fire();
    expect(sink.resizes.at(-1)).toStrictEqual({ width: 800, pixelRatio: 2 });
  });

  it('после смены DPR запрос встаёт на новый DPR — второй перенос тоже пойман, старый слушатель снят', () => {
    const { screen, sink, watcher } = setup();
    watcher.start();
    const [first] = screen.live(resolutionQuery(1));
    screen.devicePixelRatio = 2;
    first?.fire();
    expect(screen.live(resolutionQuery(1))).toStrictEqual([]);
    const [second] = screen.live(resolutionQuery(2));
    expect(second).toBeDefined();
    screen.devicePixelRatio = 1.5;
    second?.fire();
    expect(sink.resizes.map((r) => r.pixelRatio)).toStrictEqual([1, 2, 1.5]);
    expect(screen.live(resolutionQuery(1.5))).toHaveLength(1);
  });

  it('reduced motion переключили в системе — рендерер узнаёт', () => {
    const { screen, sink, watcher } = setup();
    watcher.start();
    const [motion] = screen.live(REDUCED_MOTION_QUERY);
    if (motion === undefined) throw new Error('нет запроса reduced motion');
    motion.matches = true;
    motion.fire();
    expect(sink.motion).toStrictEqual([false, true]);
  });

  it('dispose снимает все подписки', () => {
    const { screen, source, watcher } = setup();
    watcher.start();
    expect(screen.queries.length).toBeGreaterThan(0);
    watcher.dispose();
    expect(screen.queries.every((list) => list.listeners.size === 0)).toBe(true);
    expect(source.listeners.size).toBe(0);
  });
});
