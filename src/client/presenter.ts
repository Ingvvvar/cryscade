import type { ShownRound } from '../core/fsm/index.ts';
import type { RoundEvent } from '../core/model/events.ts';
import { SceneState, buildSchedule, groupAt, sampleScene, type Schedule, type ScheduleOptions } from '../core/presentation/index.ts';

/** Параметры показа. Расписание читает их на старте раунда: турбо и reduced motion посреди раунда ждут следующего. */
export interface PresentationSettings {
  options(): ScheduleOptions;
  /** Пресет разрешает пропуск (slam stop); в строгом его нет. */
  readonly skip: boolean;
}

/** Контрольная точка показа (§6.5): индекс группы раунда — переживает смену турбо и пресета между перезагрузками. */
export interface CheckpointStore {
  /** Группа, с которой продолжать раунд roundId; нет, испорчена или от другого раунда — null. */
  read(roundId: string): number | null;
  write(roundId: string, group: number): void;
}

/** Что показ сообщает контроллеру. */
/**
 * Ход часов показа — для звука (§12): показ раунда начался (новый — с 0, восстановленный — с начала группы) и каждый
 * сдвиг часов. jumped — пропуск: сегменты между fromMs и toMs не звучат. Сетка покоя, стоп-кадр зонда и брошенный
 * показ — не раунд: о них слушатель не слышит.
 */
export interface ClockListener {
  started(schedule: Schedule, fromMs: number): void;
  advanced(fromMs: number, toMs: number, jumped: boolean): void;
}

export interface PresentationListener {
  /** Часы встали на точке удержания featureIntro. */
  held(): void;
  /** Показ раунда дошёл до конца — после счётчика. */
  finished(): void;
}

/** Что контроллеру нужно от показа. */
export interface Presentation {
  listen(listener: PresentationListener): void;
  /** Показ раунда: новый — с начала, восстановленный — с начала группы контрольной точки. */
  play(round: ShownRound, restored: boolean): void;
  /** Сетка покоя (authenticate): падает, как первая сетка. */
  rest(grid: readonly number[]): void;
  /**
   * Пропуск (§8.2): счёт тапов — в пределах единицы (спина или празднования большого выигрыша), на старте каждой с нуля;
   * первый — к концу текущей группы, второй — к концу единицы. Точку удержания не перепрыгивает.
   */
  skip(): void;
  /** Часы идут дальше с точки удержания. */
  resume(): void;
  /** Показ брошен (замок отняли): часы стоят, о конце показа никто не узнает. */
  halt(): void;
}

const NO_LISTENER: PresentationListener = { held: () => undefined, finished: () => undefined };

/**
 * Часы показа (§8.2): расписание раунда, время и кадр. Тикер рендера двигает часы целыми миллисекундами — дробное время
 * тикера становится целым в одном месте, в часах кадра (render/frame-clock.ts); кадр — sampleScene в свой SceneState.
 * Прежняя сетка следующего раунда — итоговая сетка прошлого показа. Часы стоят на точке удержания featureIntro, пока
 * машина состояний не скажет resume, и пока вкладка скрыта.
 */
export class Presenter implements Presentation {
  readonly scene = new SceneState();
  readonly #settings: PresentationSettings;
  readonly #checkpoints: CheckpointStore;
  #listener: PresentationListener = NO_LISTENER;
  #clockListener: ClockListener | null = null;
  #schedule: Schedule | null = null;
  #clock = 0;
  #shown: readonly number[] | null = null;
  /** Раунд показа; null — сетка покоя или стоп-кадр зонда: о них контроллер не слышит. */
  #roundId: string | null = null;
  #frozen = false;
  #halted = false;
  #hidden = false;
  #held = false;
  /** Следующая точка удержания в schedule.holds. */
  #nextHold = 0;
  /** Тапы пропуска в единице #skipUnit: новая единица — счёт с нуля. */
  #skips = 0;
  #skipUnit = -1;
  #group = -1;
  #finishedSent = false;
  /** С какого момента начался показ раунда: 0 — новый, начало группы — восстановленный. */
  #startMs = 0;

  constructor(settings: PresentationSettings, checkpoints: CheckpointStore) {
    this.#settings = settings;
    this.#checkpoints = checkpoints;
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

  /** Часы стоят на точке удержания featureIntro. */
  get held(): boolean {
    return this.#held;
  }

  /** Группа расписания, в которой сейчас часы; −1 — показа нет. */
  get group(): number {
    return this.#group;
  }

  /** Момент, с которого начался показ раунда: 0 — новый раунд, начало группы контрольной точки — восстановленный. */
  get startMs(): number {
    return this.#startMs;
  }

  listen(listener: PresentationListener): void {
    this.#listener = listener;
  }

  /** Слушатель хода часов — звук. Раунд уже идёт (звук догрузился посреди него) — слушатель слышит его с текущего места. */
  observe(listener: ClockListener | null): void {
    this.#clockListener = listener;
    const schedule = this.#schedule;
    if (listener === null || schedule === null || this.#roundId === null || this.#halted || this.#clock >= schedule.durationMs) return;
    listener.started(schedule, this.#clock);
  }

  play(round: ShownRound, restored: boolean): void {
    const schedule = this.#start(round.events, round.betMinor, round.winMinor, this.#settings.options());
    this.#roundId = round.roundId;
    const group = restored ? this.#checkpoints.read(round.roundId) : null;
    const from = group !== null && Number.isSafeInteger(group) ? schedule.groups[group] : undefined;
    this.#clock = from?.startMs ?? 0;
    this.#startMs = this.#clock;
    while ((schedule.holds[this.#nextHold] ?? Number.POSITIVE_INFINITY) < this.#clock) this.#nextHold += 1;
    this.#mark();
    this.#clockListener?.started(schedule, this.#clock);
  }

  rest(grid: readonly number[]): void {
    this.#start(restEvents(grid), 0, 0, this.#settings.options());
  }

  /** Зонд (dev и e2e): показ стоит на tMs — снимок кадра на поддельных часах. */
  still(round: ShownRound, tMs: number, options: ScheduleOptions): void {
    const schedule = this.#start(round.events, round.betMinor, round.winMinor, options);
    this.#clock = Math.min(tMs, schedule.durationMs);
    this.#frozen = true;
  }

  skip(): void {
    const schedule = this.#schedule;
    if (schedule === null || this.#roundId === null || !this.#settings.skip || this.#held || this.#halted) return;
    const group = schedule.groups[groupAt(schedule, this.#clock)];
    if (group === undefined) return;
    if (group.unit !== this.#skipUnit) {
      this.#skipUnit = group.unit;
      this.#skips = 0;
    }
    this.#skips += 1;
    this.#advanceTo(this.#skips === 1 ? group.endMs : (schedule.unitEnds[group.unit] ?? schedule.durationMs), true);
  }

  resume(): void {
    this.#held = false;
  }

  halt(): void {
    this.#halted = true;
  }

  /** Вкладка скрыта — часы показа стоят (§8.2). */
  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
  }

  /** pagehide: контрольная точка — группа, в которой часы сейчас. */
  saveCheckpoint(): void {
    if (this.#roundId !== null && this.#group >= 0) this.#checkpoints.write(this.#roundId, this.#group);
  }

  tick(deltaMs: number): SceneState {
    const schedule = this.#schedule;
    if (schedule === null) return this.scene;
    if (!this.#frozen && !this.#halted && !this.#hidden && !this.#held) this.#advanceTo(this.#clock + deltaMs, false);
    sampleScene(schedule, this.#clock, this.scene);
    return this.scene;
  }

  /** Часы вперёд до target: не дальше точки удержания и конца; на границе группы — контрольная точка. jumped — пропуск. */
  #advanceTo(target: number, jumped: boolean): void {
    const schedule = this.#schedule;
    if (schedule === null) return;
    const hold = this.#roundId === null ? Number.POSITIVE_INFINITY : (schedule.holds[this.#nextHold] ?? Number.POSITIVE_INFINITY);
    const stop = Math.min(target, hold, schedule.durationMs);
    const from = this.#clock;
    this.#clock = Math.max(this.#clock, stop);
    this.#mark();
    if (this.#roundId === null) return;
    if (this.#clock > from) this.#clockListener?.advanced(from, this.#clock, jumped);
    if (this.#clock >= hold) {
      this.#nextHold += 1;
      this.#held = true;
      this.#listener.held();
      return;
    }
    if (this.#clock >= schedule.durationMs && !this.#finishedSent) {
      this.#finishedSent = true;
      this.#listener.finished();
    }
  }

  /** Группа часов сменилась — её индекс в контрольную точку раунда. */
  #mark(): void {
    const schedule = this.#schedule;
    if (schedule === null) return;
    const group = groupAt(schedule, this.#clock);
    if (group === this.#group) return;
    this.#group = group;
    if (this.#roundId !== null) this.#checkpoints.write(this.#roundId, group);
  }

  #start(events: readonly RoundEvent[], betMinor: number, winMinor: number, options: ScheduleOptions): Schedule {
    const schedule = buildSchedule({ events, betMinor, winMinor, previousGrid: this.#shown }, options);
    this.#schedule = schedule;
    this.#clock = 0;
    this.#roundId = null;
    this.#frozen = false;
    this.#halted = false;
    this.#held = false;
    this.#nextHold = 0;
    this.#skips = 0;
    this.#skipUnit = -1;
    this.#group = -1;
    this.#finishedSent = false;
    this.#startMs = 0;
    this.#shown = Array.from(schedule.finalGrid);
    return schedule;
  }
}

/** Раунд покоя: одна сетка без выигрыша — чтобы и она падала по тому же расписанию. */
function restEvents(grid: readonly number[]): RoundEvent[] {
  return [
    { t: 'fill', grid: [...grid] },
    { t: 'end', payX100: 0 },
  ];
}
