// Параметры показа от игрока и страницы (§8.2, §11): турбо — кнопка панели, пресет — ?jurisdiction=strict (с фазы 7 —
// и настройки), reduced motion — медиа-запрос. Показ читает их на старте раунда: переключённые посреди раунда действуют
// со следующего. Турбо и пропуск — только если пресет их разрешает; имя пресета нигде не сравнивается.

import { PRESETS, type PresetFlags, type PresentationSettings, type ScheduleOptions } from '../client/index.ts';
import type { MediaQueryListLike } from './viewport-watcher.ts';

export interface PreferencesView {
  readonly turbo: boolean;
  /** Пресет разрешает турбо: иначе кнопка выключена. */
  readonly turboAllowed: boolean;
}

/** Что панели нужно от параметров показа: кнопка турбо. */
export interface TurboSwitch {
  getSnapshot(): PreferencesView;
  subscribe(listener: () => void): () => void;
  toggleTurbo(): void;
}

export class PresentationPreferences implements PresentationSettings, TurboSwitch {
  readonly #preset: PresetFlags;
  readonly #motion: MediaQueryListLike;
  readonly #listeners = new Set<() => void>();
  #view: PreferencesView;

  constructor(preset: PresetFlags, motion: MediaQueryListLike) {
    this.#preset = preset;
    this.#motion = motion;
    this.#view = { turbo: false, turboAllowed: preset.turbo };
  }

  get skip(): boolean {
    return this.#preset.skip;
  }

  options(): ScheduleOptions {
    return { speed: this.#view.turbo && this.#preset.turbo ? 'turbo' : 'normal', preset: this.#preset, reducedMotion: this.#motion.matches };
  }

  toggleTurbo(): void {
    if (!this.#preset.turbo) return;
    this.#view = { ...this.#view, turbo: !this.#view.turbo };
    for (const listener of [...this.#listeners]) listener();
  }

  getSnapshot(): PreferencesView {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** Пресет страницы: ?jurisdiction=strict — строгий, иначе обычный. */
export function presetChoice(search: string): PresetFlags {
  return new URLSearchParams(search).get('jurisdiction') === 'strict' ? PRESETS.strict : PRESETS.standard;
}
