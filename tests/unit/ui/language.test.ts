import { describe, expect, it } from 'vitest';
import type { Dictionary, Language } from '../../../src/ui/i18n/dictionary.ts';
import { EN } from '../../../src/ui/i18n/en.ts';
import { UK } from '../../../src/ui/i18n/uk.ts';
import { LanguageStore } from '../../../src/ui/language.ts';
import { SCENE_TEXTS } from '../../../src/ui/scene-texts.ts';

// Язык игрока (§11): словарь, формат сумм и надписи сцены одним снимком; английский грузит загрузчик; поздний выбор
// побеждает; словарь не загрузился — язык прежний.

class Loader {
  readonly calls: Language[] = [];
  readonly #pending: { language: Language; resolve: (dict: Dictionary) => void; reject: (error: Error) => void }[] = [];

  readonly load = (language: Language): Promise<Dictionary> => {
    this.calls.push(language);
    return new Promise((resolve, reject) => {
      this.#pending.push({ language, resolve, reject });
    });
  };

  answer(at: number, dict: Dictionary): void {
    this.#pending[at]?.resolve(dict);
  }

  fail(at: number): void {
    this.#pending[at]?.reject(new Error('chunk'));
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('LanguageStore', () => {
  it('украинский сразу: словарь, суммы uk-UA, надписи сцены', () => {
    const view = new LanguageStore(UK, new Loader().load).getSnapshot();
    expect([view.dict, view.money.format(100_000), view.scene]).toStrictEqual([UK, '1 000,00', SCENE_TEXTS.uk]);
  });

  it('английский — через загрузчик; снимок сменился целиком, подписчики слышат', async () => {
    const loader = new Loader();
    const store = new LanguageStore(UK, loader.load);
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    const chosen = store.choose('en');
    loader.answer(0, EN);
    expect(await chosen).toBe(true);
    const view = store.getSnapshot();
    expect([view.dict, view.money.format(100_000), view.scene, heard, loader.calls]).toStrictEqual([EN, '1,000.00', SCENE_TEXTS.en, 1, ['en']]);
  });

  it('тот же язык — без загрузки; поздний выбор побеждает ранний', async () => {
    const loader = new Loader();
    const store = new LanguageStore(UK, loader.load);
    expect(await store.choose('uk')).toBe(true);
    expect(loader.calls).toStrictEqual([]);
    const early = store.choose('en');
    const late = store.choose('uk');
    loader.answer(0, EN);
    expect([await early, await late, store.getSnapshot().dict]).toStrictEqual([false, true, UK]);
  });

  it('словарь не загрузился — язык прежний, подписчики не слышат', async () => {
    const loader = new Loader();
    const store = new LanguageStore(UK, loader.load);
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    const chosen = store.choose('en');
    loader.fail(0);
    await flush();
    expect([await chosen, store.getSnapshot().dict, heard]).toStrictEqual([false, UK, 0]);
  });
});
