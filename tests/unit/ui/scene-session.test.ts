import { describe, expect, it } from 'vitest';
import { SceneState } from '../../../src/core/presentation/index.ts';
import type { Layout, Viewport } from '../../../src/render/layout.ts';
import type { NumberStyle } from '../../../src/render/number-layout.ts';
import type { Renderer, RendererInfo, SceneSource, SceneTexts } from '../../../src/render/renderer.ts';
import { SCENE_TEXTS } from '../../../src/ui/scene-texts.ts';
import { SceneSession, type MountObserver } from '../../../src/ui/scene-session.ts';

const HOST = {} as HTMLElement;
const SOURCE: SceneSource = { tick: () => new SceneState(), schedule: null, finished: false };
const PORTRAIT: Viewport = { width: 390, height: 844, insets: { top: 47, right: 0, bottom: 34, left: 0 } };
const LANDSCAPE: Viewport = { width: 1280, height: 720, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
const EN_NUMBERS: NumberStyle = { group: ',', decimal: '.', groupFrom: 1000 };

class FakeRenderer implements Renderer {
  readonly calls: string[] = [];
  #resolve: (() => void) | null = null;

  init(): Promise<RendererInfo> {
    return new Promise((resolve) => {
      this.#resolve = () => {
        resolve({ name: 'webgl', gpu: 'fake', software: false });
      };
    });
  }

  finishInit(): void {
    this.#resolve?.();
  }

  destroy(): void {
    this.calls.push('destroy');
  }

  resize(viewport: Viewport, pixelRatio: number): void {
    this.calls.push(`resize ${String(viewport.width)}@${String(pixelRatio)}`);
  }

  setReducedMotion(on: boolean): void {
    this.calls.push(`motion ${String(on)}`);
  }

  setSource(source: SceneSource | null): void {
    this.calls.push(`source ${source === null ? 'нет' : 'есть'}`);
  }

  setLanguage(texts: SceneTexts, numbers: NumberStyle): void {
    this.calls.push(`language ${texts.freeSpins} ${numbers.decimal}`);
  }
}

class Counter implements MountObserver {
  readonly log: string[] = [];
  noteAttach(): void {
    this.log.push('attach');
  }
  noteDetach(): void {
    this.log.push('detach');
  }
  noteError(): void {
    this.log.push('error');
  }
  bindRemount(): void {
    this.log.push('bind');
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(): { session: SceneSession; renderers: FakeRenderer[]; layouts: Layout[]; observer: Counter } {
  const renderers: FakeRenderer[] = [];
  const layouts: Layout[] = [];
  const observer = new Counter();
  const session = new SceneSession({
    create: () => {
      const renderer = new FakeRenderer();
      renderers.push(renderer);
      return renderer;
    },
    onLayout: (layout) => layouts.push(layout),
    onError: () => undefined,
    observer,
  });
  return { session, renderers, layouts, observer };
}

describe('SceneSession', () => {
  it('состояние окна и источник кадра до готовности копятся и уходят рендереру по готовности', async () => {
    const { session, renderers } = setup();
    session.attach(HOST);
    session.resize(PORTRAIT, 3);
    session.setReducedMotion(true);
    session.setSource(SOURCE);
    await flush();
    renderers[0]?.finishInit();
    await flush();
    expect(renderers[0]?.calls).toStrictEqual(['resize 390@3', 'motion true', 'source есть']);
  });

  it('источник после готовности идёт рендереру сразу; без источника рендерер получает null', async () => {
    const { session, renderers } = setup();
    session.attach(HOST);
    await flush();
    renderers[0]?.finishInit();
    await flush();
    expect(renderers[0]?.calls).toStrictEqual(['motion false', 'source нет']);
    session.setSource(SOURCE);
    expect(renderers[0]?.calls).toStrictEqual(['motion false', 'source нет', 'source есть']);
  });

  it('после готовности изменения окна идут рендереру сразу', async () => {
    const { session, renderers } = setup();
    session.attach(HOST);
    await flush();
    renderers[0]?.finishInit();
    await flush();
    session.resize(LANDSCAPE, 2);
    expect(renderers[0]?.calls.at(-1)).toBe('resize 1280@2');
  });

  it('язык до готовности копится и уходит рендереру по готовности; после — сразу; новый рендерер получает последний', async () => {
    const { session, renderers } = setup();
    session.attach(HOST);
    session.setLanguage(SCENE_TEXTS.uk, { group: '\u00a0', decimal: ',', groupFrom: 1000 });
    session.setLanguage(SCENE_TEXTS.en, EN_NUMBERS);
    await flush();
    renderers[0]?.finishInit();
    await flush();
    expect(renderers[0]?.calls).toStrictEqual(['motion false', 'source нет', 'language Free spins .']);
    session.setLanguage(SCENE_TEXTS.uk, { group: '\u00a0', decimal: ',', groupFrom: 1000 });
    expect(renderers[0]?.calls.at(-1)).toBe('language Фріспіни ,');
    session.detach();
    session.attach(HOST);
    await flush();
    renderers[1]?.finishInit();
    await session.settled;
    expect(renderers[1]?.calls.at(-1)).toBe('language Фріспіни ,');
  });

  it('раскладка для панели считается на каждый вьюпорт — и без рендерера', () => {
    const { session, layouts } = setup();
    session.resize(PORTRAIT, 1);
    session.resize(LANDSCAPE, 1);
    expect(layouts.map((layout) => layout.orientation)).toStrictEqual(['portrait', 'landscape']);
  });

  it('StrictMode: монтирований 2, рендерер создан один, и он получает состояние', async () => {
    const { session, renderers, observer } = setup();
    session.attach(HOST);
    session.detach();
    session.attach(HOST);
    session.resize(PORTRAIT, 2);
    session.setSource(SOURCE);
    await flush();
    expect(renderers).toHaveLength(1);
    renderers[0]?.finishInit();
    await session.settled;
    expect(observer.log).toStrictEqual(['attach', 'detach', 'attach']);
    expect(renderers[0]?.calls).toStrictEqual(['resize 390@2', 'motion false', 'source есть']);
  });
});
