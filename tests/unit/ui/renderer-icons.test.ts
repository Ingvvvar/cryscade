import { describe, expect, it } from 'vitest';
import type { SymbolIcons } from '../../../src/render/renderer.ts';
import { RendererIcons } from '../../../src/ui/renderer-icons.ts';

// Иконки правил (прогон №3, п.0): держатель отдаёт иконки рендерера, которого фабрика создала последним; без рендерера —
// null, и правила пишут имена текстом.

class FakeIcons implements SymbolIcons {
  readonly #urls: readonly string[] | null;
  constructor(urls: readonly string[] | null) {
    this.#urls = urls;
  }
  symbolIcons(): Promise<readonly string[] | null> {
    return Promise.resolve(this.#urls);
  }
}

describe('RendererIcons', () => {
  it('рендерера ещё нет — null', async () => {
    expect(await new RendererIcons().symbolIcons()).toBeNull();
  });

  it('track отдаёт тот же рендерер; иконки — у последнего созданного', async () => {
    const icons = new RendererIcons();
    const first = new FakeIcons(['a']);
    const second = new FakeIcons(['b']);
    expect(icons.track(first)).toBe(first);
    expect(await icons.symbolIcons()).toStrictEqual(['a']);
    icons.track(second);
    expect(await icons.symbolIcons()).toStrictEqual(['b']);
  });

  it('сцена рендерера не готова — его null, а не иконки прежнего', async () => {
    const icons = new RendererIcons();
    icons.track(new FakeIcons(['a']));
    icons.track(new FakeIcons(null));
    expect(await icons.symbolIcons()).toBeNull();
  });
});
