// Звук по первому жесту (§12, решения 1 и 5 фазы 8): AudioContext создаётся синхронно в том же жесте — без него
// WebKit контекст не запустит, — а модуль звука грузится динамическим импортом после (он ленивый, в начальном JS его
// нет). Мьют — из настройки «Звук»; скрытая вкладка — контекст на паузе. Нет WebAudio или модуль не загрузился — игра
// идёт без звука.

import type { ClockListener } from '../client/index.ts';
import type { ExternalSource } from './external.ts';

/** Что ворота отдают звуку: часы показа его слушают, мьют и пауза приходят снаружи. */
export interface SoundSink extends ClockListener {
  setMuted(on: boolean): void;
  setHidden(on: boolean): void;
}

export interface SoundGateOptions {
  /** Окно: первый pointerdown или keydown — жест. */
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** Новый AudioContext — в жесте; null — WebAudio нет. */
  readonly createContext: () => AudioContext | null;
  /** Ленивый модуль звука: директор на контексте из жеста. */
  readonly load: (context: AudioContext) => Promise<SoundSink>;
  /** Часы показа: слушателя хода получают, когда звук готов. */
  readonly clock: { observe(listener: ClockListener | null): void };
  /** Настройка «Звук»: выключена — мьют. */
  readonly enabled: ExternalSource<boolean>;
  /** Вкладка скрыта сейчас и подписка на смену. */
  readonly hidden: ExternalSource<boolean>;
}

const GESTURES = ['pointerdown', 'keydown'] as const;

export class SoundGate {
  readonly #options: SoundGateOptions;
  readonly #first = (): void => {
    this.#disarm();
    this.#open();
  };
  #armed = false;
  #sink: SoundSink | null = null;

  constructor(options: SoundGateOptions) {
    this.#options = options;
  }

  /** Ждать первого жеста; повторный вызов ничего не меняет. */
  arm(): void {
    if (this.#armed || this.#sink !== null) return;
    this.#armed = true;
    for (const type of GESTURES) this.#options.target.addEventListener(type, this.#first, { capture: true });
  }

  /** Звук готов — для тестов и зонда. */
  get ready(): boolean {
    return this.#sink !== null;
  }

  #disarm(): void {
    if (!this.#armed) return;
    this.#armed = false;
    for (const type of GESTURES) this.#options.target.removeEventListener(type, this.#first, { capture: true });
  }

  #open(): void {
    const { createContext, load, clock, enabled, hidden } = this.#options;
    const context = createContext();
    if (context === null) return;
    void load(context).then(
      (sink) => {
        this.#sink = sink;
        sink.setMuted(!enabled.getSnapshot());
        sink.setHidden(hidden.getSnapshot());
        enabled.subscribe(() => {
          sink.setMuted(!enabled.getSnapshot());
        });
        hidden.subscribe(() => {
          sink.setHidden(hidden.getSnapshot());
        });
        clock.observe(sink);
      },
      () => undefined,
    );
  }
}
