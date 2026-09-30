import type { ShownRound } from '../core/fsm/index.ts';
import type { RoundEvent } from '../core/model/events.ts';
import { SceneState, buildSchedule, sampleScene, type Schedule, type ScheduleOptions } from '../core/presentation/index.ts';

/** Параметры показа: читаются при старте раунда — турбо и reduced motion, переключённые посреди раунда, ждут следующего. */
export interface PresentationSettings {
  options(): ScheduleOptions;
}

/** Что контроллеру нужно от показа. */
export interface Presentation {
  /** Показ раунда с начала. */
  play(round: ShownRound): void;
  /** Сетка покоя (authenticate): падает, как первая сетка. */
  rest(grid: readonly number[]): void;
}

/**
 * Часы показа (§8.2): расписание раунда, время и кадр. Тикер рендера двигает часы, кадр — sampleScene в свой SceneState;
 * в кадр — целые миллисекунды (sample-scene.ts). Прежняя сетка следующего раунда — итоговая сетка прошлого показа.
 */
export class Presenter implements Presentation {
  readonly scene = new SceneState();
  readonly #settings: PresentationSettings;
  #schedule: Schedule | null = null;
  #clock = 0;
  #frozen = false;
  #shown: readonly number[] | null = null;

  constructor(settings: PresentationSettings) {
    this.#settings = settings;
  }

  get schedule(): Schedule | null {
    return this.#schedule;
  }

  /** Время показа, мс. */
  get clock(): number {
    return this.#clock;
  }

  /** Показ дошёл до конца. */
  get finished(): boolean {
    return this.#schedule !== null && this.#clock >= this.#schedule.durationMs;
  }

  play(round: ShownRound): void {
    this.#start(round.events, round.betMinor, round.winMinor, this.#settings.options());
  }

  rest(grid: readonly number[]): void {
    this.#start(restEvents(grid), 0, 0, this.#settings.options());
  }

  /** Зонд (dev и e2e): показ стоит на tMs — снимок кадра на поддельных часах. */
  still(round: ShownRound, tMs: number, options: ScheduleOptions): void {
    this.#start(round.events, round.betMinor, round.winMinor, options);
    this.#clock = Math.min(tMs, this.#schedule?.durationMs ?? 0);
    this.#frozen = true;
  }

  tick(deltaMs: number): SceneState {
    const schedule = this.#schedule;
    if (schedule === null) return this.scene;
    if (!this.#frozen) this.#clock = Math.min(this.#clock + deltaMs, schedule.durationMs);
    sampleScene(schedule, Math.round(this.#clock), this.scene);
    return this.scene;
  }

  #start(events: readonly RoundEvent[], betMinor: number, winMinor: number, options: ScheduleOptions): void {
    const schedule = buildSchedule({ events, betMinor, winMinor, previousGrid: this.#shown }, options);
    this.#schedule = schedule;
    this.#clock = 0;
    this.#frozen = false;
    this.#shown = Array.from(schedule.finalGrid);
  }
}

/** Раунд покоя: одна сетка без выигрыша — чтобы и она падала по тому же расписанию. */
function restEvents(grid: readonly number[]): RoundEvent[] {
  return [
    { t: 'fill', grid: [...grid] },
    { t: 'end', payX100: 0 },
  ];
}
