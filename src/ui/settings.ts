// Настройки игрока (§11, фаза 7; звук — фаза 8): язык, пресет и звук — в localStorage одной записью. Хранилище бывает недоступно (приватный
// режим, запрет сайта — сам доступ бросает) и испорчено: тогда умолчания, игра идёт, запись молча не удаётся.
// ?jurisdiction= сильнее настройки: пресет из ссылки настройка не меняет (jurisdictionParam).

import { isRecord } from '../protocol/index.ts';
import type { KeyValueStore, PresetName } from '../client/index.ts';
import { LANGUAGES, type Language } from './i18n/dictionary.ts';

export interface SettingsView {
  readonly language: Language;
  readonly preset: PresetName;
  /** Звук включён (§12): выключен — мьют обеих шин. */
  readonly sound: boolean;
}

export const SETTINGS_KEY = 'cryscade:settings';

const PRESET_NAMES: readonly PresetName[] = ['standard', 'strict'];

export const DEFAULT_SETTINGS: SettingsView = { language: 'uk', preset: 'standard', sound: true };

function parse(raw: string): SettingsView | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['v'] !== 1) return null;
  const language = LANGUAGES.find((item) => item === value['language']);
  const preset = PRESET_NAMES.find((item) => item === value['preset']);
  // Запись фазы 7 звука не знает — он включён.
  const sound = value['sound'] ?? true;
  return language === undefined || preset === undefined || typeof sound !== 'boolean' ? null : { language, preset, sound };
}

export class SettingsStore {
  readonly #store: () => KeyValueStore;
  readonly #listeners = new Set<() => void>();
  #view: SettingsView;

  /** store — геттер: сам доступ к localStorage бросает, когда хранилище закрыто (SecurityError). */
  constructor(store: () => KeyValueStore) {
    this.#store = store;
    this.#view = this.#read();
  }

  getSnapshot(): SettingsView {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setLanguage(language: Language): void {
    this.#write({ ...this.#view, language });
  }

  setPreset(preset: PresetName): void {
    this.#write({ ...this.#view, preset });
  }

  setSound(sound: boolean): void {
    this.#write({ ...this.#view, sound });
  }

  #read(): SettingsView {
    let raw: string | null;
    try {
      raw = this.#store().getItem(SETTINGS_KEY);
    } catch {
      return DEFAULT_SETTINGS;
    }
    return raw === null ? DEFAULT_SETTINGS : (parse(raw) ?? DEFAULT_SETTINGS);
  }

  #write(next: SettingsView): void {
    if (next.language === this.#view.language && next.preset === this.#view.preset && next.sound === this.#view.sound) return;
    this.#view = next;
    try {
      this.#store().setItem(SETTINGS_KEY, JSON.stringify({ v: 1, language: next.language, preset: next.preset, sound: next.sound }));
    } catch {
      // Хранилище недоступно: настройка живёт до перезагрузки.
    }
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Пресет из ссылки: ?jurisdiction=strict или standard — сильнее настройки; иначе null — решает настройка. */
export function jurisdictionParam(search: string): PresetName | null {
  const value = new URLSearchParams(search).get('jurisdiction');
  return PRESET_NAMES.find((name) => name === value) ?? null;
}
