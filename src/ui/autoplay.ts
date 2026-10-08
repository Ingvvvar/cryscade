// Автоигра (§11, решение 4 фазы 7): 10 / 25 / 50 / 100 спинов. Только жмёт «Спін» за игрока — мимо машины состояний
// не ходит — и сама продолжает плашку фичи. Лимит потерь обязателен (по умолчанию 10 ставок), остановка на фиче —
// по умолчанию, на выигрыше от N× — по выбору. Останавливается с причиной, а не молча: на любой ошибке, на нехватке
// средств, на отказе сервера и когда спин не ушёл, потому что раунд держит другая вкладка (§15, предел фазы 4).
// В строгом пресете её нет.

import type { ControllerSnapshot, SettledRound } from '../client/index.ts';

export const AUTOPLAY_COUNTS = [10, 25, 50, 100] as const;

export type AutoplayCount = (typeof AUTOPLAY_COUNTS)[number];

export interface AutoplayOptions {
  readonly count: AutoplayCount;
  /** Лимит потерь в ставках — обязателен, целое от 1. */
  readonly lossLimitBets: number;
  readonly stopOnFeature: boolean;
  /** Остановка на выигрыше от N× ставки; null — без неё. */
  readonly stopOnWinX: number | null;
}

export const DEFAULT_AUTOPLAY: AutoplayOptions = { count: 10, lossLimitBets: 10, stopOnFeature: true, stopOnWinX: null };

/** Почему автоигра остановилась. */
export type AutoplayStop = 'done' | 'lossLimit' | 'feature' | 'bigWin' | 'error' | 'funds' | 'refused' | 'otherTab' | 'player';

export type AutoplayView =
  | { readonly kind: 'off' }
  | { readonly kind: 'running'; readonly left: number }
  | { readonly kind: 'stopped'; readonly reason: AutoplayStop };

/** Что автоигре нужно от игры: снимок, «Спін», тап по плашке и закрытые раунды. */
export interface AutoplayGame {
  getSnapshot(): ControllerSnapshot;
  subscribe(listener: () => void): () => void;
  spin(): void;
  tap(): void;
  onRoundSettled(listener: (round: SettledRound) => void): () => void;
}

/** Таймеры корня композиции: в браузере setTimeout, в тестах — поддельные. Вернёт отмену. */
type Schedule = (ms: number, task: () => void) => () => void;

/** Пауза между спинами серии — итог раунда успевает показаться. */
export const AUTOPLAY_PAUSE_MS = 400;
/** Плашка фичи стоит столько, прежде чем автоигра её продолжит. */
export const AUTOPLAY_PLAQUE_MS = 800;

const OFF: AutoplayView = { kind: 'off' };

interface Run {
  readonly options: AutoplayOptions;
  readonly betMinor: number;
  readonly startBalance: number;
  left: number;
  /** Спин серии нажат, раунд ещё не вернулся в покой. */
  pending: boolean;
  /** В раунде серии была плашка фичи. */
  feature: boolean;
  /** Итог раунда серии — из ответа endRound; null — раунд закрыла не эта вкладка или его не было. */
  settled: SettledRound | null;
  /** Отмена отложенного действия: следующего спина или тапа по плашке. */
  cancel: (() => void) | null;
}

export class Autoplay {
  readonly #game: AutoplayGame;
  readonly #schedule: Schedule;
  readonly #allowed: () => boolean;
  readonly #listeners = new Set<() => void>();
  #view: AutoplayView = OFF;
  #run: Run | null = null;
  #unsubscribe: (() => void) | null = null;

  /** allowed — пресет разрешает автоигру (флаг выбранного пресета: строгий её запрещает). */
  constructor(game: AutoplayGame, schedule: Schedule, allowed: () => boolean) {
    this.#game = game;
    this.#schedule = schedule;
    this.#allowed = allowed;
  }

  getSnapshot(): AutoplayView {
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Серия — только в покое игры (повтор по ссылке в покой не приходит), только если пресет разрешает и ставка известна;
   * лимит потерь — целое от 1.
   */
  start(options: AutoplayOptions): void {
    const snapshot = this.#game.getSnapshot();
    if (this.#run !== null || !this.#allowed() || snapshot.state.name !== 'idle') return;
    const { betMinor, balanceMinor } = snapshot;
    if (betMinor === null || balanceMinor === null || !Number.isSafeInteger(options.lossLimitBets) || options.lossLimitBets < 1) return;
    this.#run = { options, betMinor, startBalance: balanceMinor, left: options.count, pending: false, feature: false, settled: null, cancel: null };
    const unsubscribeState = this.#game.subscribe(() => {
      this.#onState();
    });
    const unsubscribeRounds = this.#game.onRoundSettled((round) => {
      if (this.#run !== null) this.#run.settled = round;
    });
    this.#unsubscribe = () => {
      unsubscribeState();
      unsubscribeRounds();
    };
    this.#press();
  }

  /** Игрок остановил серию. */
  stop(): void {
    this.#halt('player');
  }

  /** Полоса с причиной остановки прочитана. */
  dismiss(): void {
    if (this.#view.kind === 'stopped') this.#publish(OFF);
  }

  #press(): void {
    const run = this.#run;
    if (run === null) return;
    const balance = this.#game.getSnapshot().balanceMinor;
    if (run.left === 0) {
      this.#halt('done');
    } else if (!this.#allowed()) {
      this.#halt('player');
    } else if (balance !== null && run.startBalance - balance >= run.options.lossLimitBets * run.betMinor) {
      this.#halt('lossLimit');
    } else {
      run.left -= 1;
      run.pending = true;
      run.feature = false;
      run.settled = null;
      this.#publish({ kind: 'running', left: run.left });
      this.#game.spin();
      // Спин не принят (не покой, нет ставки) — серия не теряет его молча.
      if (this.#game.getSnapshot().state.name === 'idle') this.#halt('refused');
    }
  }

  #onState(): void {
    const run = this.#run;
    if (run === null) return;
    const state = this.#game.getSnapshot().state;
    if (state.name === 'error') {
      this.#halt('error');
    } else if (state.name === 'waitingForTab') {
      this.#halt('otherTab');
    } else if (state.name === 'featureIntro') {
      run.feature = true;
      if (run.cancel === null) {
        run.cancel = this.#schedule(AUTOPLAY_PLAQUE_MS, () => {
          run.cancel = null;
          if (this.#run === run && this.#game.getSnapshot().state.name === 'featureIntro') this.#game.tap();
        });
      }
    } else if (state.name === 'idle') {
      this.#onIdle(run, state.refusal);
    }
  }

  /** Покой после спина серии: отказ — остановка; иначе раунд вернулся — остановки по его итогу, потом пауза и спин. */
  #onIdle(run: Run, refusal: string | null): void {
    if (refusal !== null) {
      this.#halt(refusal === 'INSUFFICIENT_FUNDS' ? 'funds' : 'refused');
      return;
    }
    if (!run.pending) return;
    run.pending = false;
    const winX = run.options.stopOnWinX;
    if (run.options.stopOnFeature && run.feature) {
      this.#halt('feature');
    } else if (winX !== null && run.settled !== null && run.settled.winMinor >= winX * run.settled.betMinor) {
      this.#halt('bigWin');
    } else {
      run.cancel?.();
      run.cancel = this.#schedule(AUTOPLAY_PAUSE_MS, () => {
        run.cancel = null;
        if (this.#run === run) this.#press();
      });
    }
  }

  #halt(reason: AutoplayStop): void {
    const run = this.#run;
    if (run === null) return;
    run.cancel?.();
    this.#run = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#publish({ kind: 'stopped', reason });
  }

  #publish(view: AutoplayView): void {
    this.#view = view;
    for (const listener of [...this.#listeners]) listener();
  }
}
