// Язык игрока (§11): словарь интерфейса, формат сумм и надписи сцены — одним снимком для useSyncExternalStore.
// Украинский — в начальном JS, английский грузит загрузчик из корня композиции (динамический импорт). Выбор, который
// обогнал более поздний, не применяется: побеждает последний.

import type { Dictionary, Language } from './i18n/dictionary.ts';
import { MoneyFormat } from './money-format.ts';
import type { SceneTexts } from '../render/renderer.ts';
import { SCENE_TEXTS } from './scene-texts.ts';

export interface LanguageView {
  readonly dict: Dictionary;
  readonly money: MoneyFormat;
  readonly scene: SceneTexts;
}

export type DictionaryLoader = (language: Language) => Promise<Dictionary>;

export function languageView(dict: Dictionary): LanguageView {
  return { dict, money: new MoneyFormat(dict.locale), scene: SCENE_TEXTS[dict.language] };
}

export class LanguageStore {
  readonly #load: DictionaryLoader;
  readonly #listeners = new Set<() => void>();
  #view: LanguageView;
  #ticket = 0;

  constructor(initial: Dictionary, load: DictionaryLoader) {
    this.#view = languageView(initial);
    this.#load = load;
  }

  getSnapshot(): LanguageView {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Сменить язык; false — словарь не загрузился или выбор уже обогнал другой: язык прежний. */
  async choose(language: Language): Promise<boolean> {
    this.#ticket += 1;
    const ticket = this.#ticket;
    if (this.#view.dict.language === language) return true;
    let dict: Dictionary;
    try {
      dict = await this.#load(language);
    } catch {
      return false;
    }
    if (ticket !== this.#ticket) return false;
    this.#view = languageView(dict);
    for (const listener of [...this.#listeners]) listener();
    return true;
  }
}
