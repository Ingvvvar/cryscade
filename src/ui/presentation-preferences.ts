// Параметры показа от игрока и страницы (§8.2, §11): турбо — кнопка панели, пресет — ?jurisdiction= или настройки,
// reduced motion — медиа-запрос. Показ читает их на старте раунда: переключённые посреди раунда действуют со
// следующего — пресет фиксируется в options(), и пропуск идёт по пресету своего раунда. Кнопки панели (турбо, автоигра)
// смотрят на выбранный пресет сразу. Имя пресета нигде не сравнивается — только флаги.

import type { PresetFlags, PresentationSettings, ScheduleOptions } from '../client/index.ts';
import type { MediaQueryListLike } from './viewport-watcher.ts';

export interface PreferencesView {
  readonly turbo: boolean;
  /** Выбранный пресет: его флаги видит панель (турбо, автоигра, сессия на экране). */
  readonly preset: PresetFlags;
}

/** Что панели нужно от параметров показа: кнопка турбо и флаги пресета. */
export interface TurboSwitch {
  getSnapshot(): PreferencesView;
  subscribe(listener: () => void): () => void;
  toggleTurbo(): void;
}

export class PresentationPreferences implements PresentationSettings, TurboSwitch {
  readonly #motion: MediaQueryListLike;
  readonly #listeners = new Set<() => void>();
  /** Пресет раунда на сцене — зафиксирован на его старте. */
  #active: PresetFlags;
  #view: PreferencesView;

  constructor(preset: PresetFlags, motion: MediaQueryListLike) {
    this.#active = preset;
    this.#motion = motion;
    this.#view = { turbo: false, preset };
  }

  get skip(): boolean {
    return this.#active.skip;
  }

  /** Старт раунда: выбранный пресет становится пресетом раунда. */
  options(): ScheduleOptions {
    this.#active = this.#view.preset;
    return { speed: this.#view.turbo && this.#active.turbo ? 'turbo' : 'normal', preset: this.#active, reducedMotion: this.#motion.matches };
  }

  toggleTurbo(): void {
    if (!this.#view.preset.turbo) return;
    this.#publish({ ...this.#view, turbo: !this.#view.turbo });
  }

  /** Выбор пресета — со следующего раунда: текущий доигрывает со своим. */
  setPreset(preset: PresetFlags): void {
    if (preset === this.#view.preset) return;
    this.#publish({ ...this.#view, preset });
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

  #publish(view: PreferencesView): void {
    this.#view = view;
    for (const listener of [...this.#listeners]) listener();
  }
}
