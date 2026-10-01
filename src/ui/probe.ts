// Тестовый зонд страницы — только dev и e2e-сборка (ui/main.tsx грузит его динамически под условием сборки).
// В прод-бандле его нет: tests/e2e/bundle.spec.ts ищет маркеры в dist/ и, положительным контролем, в dist-e2e/.

import { PRESETS, type ControllerSnapshot, type LabSettings, type Presenter, type Transport } from '../client/index.ts';
import { PROBE_CHANNEL, checkForceRoundAck, type ForceRound, type ForceRoundAck } from '../protocol/index.ts';
import { SceneProbe } from '../render/pixi/inspector.ts';
import { FORCED_SEEDS, type ForcedName } from './forced-rounds.ts';
import type { CryscadeProbe, MountCounts, PresentationInfo, ProbeLab, ScheduleSummary, SentBody } from './probe-api.ts';
import type { MountObserver } from './scene-session.ts';

/** Что зонду нужно от контроллера: снимок, подписка и тап игрока (пропуск показа). */
interface GameView {
  getSnapshot(): ControllerSnapshot;
  subscribe(listener: () => void): () => void;
  tap(): void;
}

/** Раунд, который показывает вкладка: показ, плашка фриспинов, доигрывание и его endRound. */
function shownRoundId(state: ControllerSnapshot['state']): string | null {
  switch (state.name) {
    case 'presenting':
    case 'featureIntro':
    case 'ending':
      return state.roundId;
    case 'restoring':
      return state.roundId;
    case 'replaying':
      return state.roundId;
    default:
      return null;
  }
}

/** Предел тапов автопропуска за один заход: раунд с сотней фриспинов — пара сотен тапов. */
const AUTO_TAPS = 10_000;

/** Идёт показ раунда (свой или восстановленный) или плашка фриспинов ждёт тапа: ключ — состояние и раунд. */
function showingKey(state: ControllerSnapshot['state']): string | null {
  if (state.name === 'presenting' || state.name === 'featureIntro') return `${state.name}:${state.roundId}`;
  if (state.name === 'restoring' && state.stage === 'show') return `restoring:${state.roundId}`;
  if (state.name === 'replaying' && (state.stage === 'showing' || state.stage === 'held')) return `replaying:${state.stage}:${String(state.roundId)}`;
  return null;
}

function idOf(message: unknown): number | null {
  if (typeof message !== 'object' || message === null) return null;
  const id = (message as { readonly id?: unknown }).id;
  return typeof id === 'number' ? id : null;
}

function bodyOf(message: unknown): SentBody | null {
  if (typeof message !== 'object' || message === null) return null;
  const body = (message as { readonly body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return null;
  const { type, idempotencyKey, roundId } = body as Record<string, unknown>;
  if (typeof type !== 'string') return null;
  return {
    type,
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    ...(typeof roundId === 'string' ? { roundId } : {}),
  };
}

export class PageProbe implements MountObserver {
  readonly scene = new SceneProbe();
  #attaches = 0;
  #detaches = 0;
  #created = 0;
  readonly #errors: string[] = [];
  #remount: (() => void) | null = null;
  #game: GameView | null = null;
  #lab: ProbeLab | null = null;
  #presenter: Presenter | null = null;
  /** ?autoskip=1 — автопропуск с загрузки и после перезагрузок посреди раунда (e2e фазы 4 не ждут показа). */
  #autoSkip = new URLSearchParams(window.location.search).get('autoskip') === '1';
  /** Серия тапов автопропуска идёт: оповещения, которые она сама вызывает, новую серию не начинают. */
  #skipping = false;
  readonly #shown: string[] = [];
  readonly #sent: SentBody[] = [];
  /** id запросов replay, ответ на которые ещё не пришёл. */
  readonly #replayIds = new Set<number>();
  /** Ответы воркера на replay как есть: e2e сверяет события повтора с посчитанными в Node. */
  readonly #replays: unknown[] = [];
  /** ?warmup=off выключает прогрев — положительный контроль его проверки; только в dev и e2e-сборке. */
  readonly warmUp = new URLSearchParams(window.location.search).get('warmup') !== 'off';

  noteAttach(): void {
    this.#attaches += 1;
  }

  noteDetach(): void {
    this.#detaches += 1;
  }

  noteCreated(): void {
    this.#created += 1;
  }

  bindRemount(remount: (() => void) | null): void {
    this.#remount = remount;
  }

  /** Корень композиции отдаёт зонду игру и её лабораторию сети. */
  bindGame(game: GameView, lab: ProbeLab): void {
    this.#game = game;
    this.#lab = lab;
    game.subscribe(() => {
      const roundId = shownRoundId(game.getSnapshot().state);
      if (roundId !== null && !this.#shown.includes(roundId)) this.#shown.push(roundId);
      this.#skipAhead();
    });
  }

  /**
   * Автопропуск — тапы игрока, пока идёт показ: два на спин (к концу группы, к концу спина), один на плашку фриспинов
   * («продолжить») и один на празднование большого выигрыша (§8.2). Тап, который ничего не сдвинул, кончает серию: в
   * строгом пресете пропуска нет.
   */
  #skipAhead(): void {
    const game = this.#game;
    if (!this.#autoSkip || game === null || this.#skipping) return;
    this.#skipping = true;
    try {
      for (let taps = 0; taps < AUTO_TAPS; taps++) {
        const key = showingKey(game.getSnapshot().state);
        if (key === null) break;
        const clock = this.#presenter?.clock;
        game.tap();
        if (showingKey(game.getSnapshot().state) === key && this.#presenter?.clock === clock) break;
      }
    } finally {
      this.#skipping = false;
    }
  }

  #presentation(): PresentationInfo | null {
    const presenter = this.#presenter;
    const schedule = presenter?.schedule ?? null;
    if (presenter === null || schedule === null) return null;
    return {
      clock: presenter.clock,
      startMs: presenter.startMs,
      group: presenter.group,
      groupStarts: schedule.groups.map((group) => group.startMs),
      durationMs: schedule.durationMs,
      held: presenter.held,
      finished: presenter.finished,
      speed: schedule.speed,
      reducedMotion: schedule.reducedMotion,
    };
  }

  /**
   * Сид следующего раунда — воркеру по каналу зонда; промис сбывается, когда воркер ответил, что принял его: канал и
   * запросы к воркеру — разные очереди, и «Спін» раньше ответа мог бы обогнать сид. Воркер слушает канал только в dev и
   * e2e-сборке; не ответил за 5 с — отказ.
   */
  #force(round: ForcedName | number): Promise<void> {
    const seed = typeof round === 'number' ? round : FORCED_SEEDS[round];
    const channel = new BroadcastChannel(PROBE_CHANNEL);
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        channel.close();
        reject(new Error(`воркер не принял сид ${String(seed)}`));
      }, 5000);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const reply: unknown = event.data;
        if (checkForceRoundAck(reply) !== null || (reply as ForceRoundAck).seed !== seed) return;
        window.clearTimeout(timer);
        channel.close();
        resolve();
      };
      const message: ForceRound = { type: 'forceRound', seed };
      channel.postMessage(message);
    });
  }

  /** Часы показа: зонд ставит показ на момент кадра. */
  bindPresenter(presenter: Presenter): void {
    this.#presenter = presenter;
  }

  /** Транспорт до воркера с журналом: что ушло после лаборатории сети, то дошло до сервера; ответы на replay — целиком. */
  record(inner: Transport): Transport {
    return {
      send: (message) => {
        const body = bodyOf(message);
        if (body !== null) this.#sent.push(body);
        const id = idOf(message);
        if (body?.type === 'replay' && id !== null) this.#replayIds.add(id);
        inner.send(message);
      },
      listen: (listener) =>
        inner.listen((message) => {
          const id = idOf(message);
          if (id !== null && this.#replayIds.delete(id)) this.#replays.push((message as { readonly body?: unknown }).body);
          listener(message);
        }),
    };
  }

  noteError(error: unknown): void {
    this.#errors.push(error instanceof Error ? error.message : String(error));
  }

  mounts(): MountCounts {
    return { attaches: this.#attaches, detaches: this.#detaches, created: this.#created, inits: this.scene.inits, destroys: this.scene.destroys };
  }

  install(target: Window & { __cryscadeProbe?: CryscadeProbe }): void {
    const scene = this.scene;
    target.__cryscadeProbe = {
      info: () => scene.info(),
      mounts: () => this.mounts(),
      errors: () => [...this.#errors],
      layout: () => scene.layout(),
      cells: () => scene.cells(),
      settled: () => scene.settled(),
      renderOnce: () => {
        scene.renderOnce();
      },
      pinAmbient: (seconds) => {
        scene.pinAmbient(seconds);
      },
      backgroundOnly: (on) => {
        scene.backgroundOnly(on);
      },
      atlasPng: () => scene.atlasPng(),
      stopTicker: () => {
        scene.stopTicker();
      },
      startTicker: () => {
        scene.startTicker();
      },
      addControlSprites: (count, kind) => {
        scene.addControlSprites(count, kind);
      },
      removeControlSprites: () => {
        scene.removeControlSprites();
      },
      remount: () => {
        if (this.#remount === null) throw new Error('сцена не смонтирована');
        this.#remount();
      },
      still: (round, tMs, options = {}) => {
        if (this.#presenter === null) throw new Error('показ не связан');
        this.#presenter.still(round, tMs, {
          speed: options.speed ?? 'normal',
          preset: options.strict === true ? PRESETS.strict : PRESETS.standard,
          reducedMotion: options.reducedMotion ?? false,
        });
      },
      schedule: () => this.#schedule(),
      presentation: () => this.#presentation(),
      force: (round) => this.#force(round),
      autoSkip: (on) => {
        this.#autoSkip = on;
        this.#skipAhead();
      },
      missingGlyphs: (texts) => scene.missingGlyphs(texts ?? null),
      chipRects: () => scene.chipRects(),
      plaqueText: () => scene.plaqueText(),
      game: () => this.#game?.getSnapshot() ?? null,
      shownRounds: () => [...this.#shown],
      sent: () => [...this.#sent],
      replays: () => [...this.#replays],
      lab: {
        set: (settings: Partial<LabSettings>) => {
          this.#labOrThrow().set(settings);
        },
        loseNextResponse: () => {
          this.#labOrThrow().loseNextResponse();
        },
        reloadMidNextRound: () => {
          this.#labOrThrow().reloadMidNextRound();
        },
        holdNextEndRound: () => {
          this.#labOrThrow().holdNextEndRound();
        },
        releaseHeld: () => {
          this.#labOrThrow().releaseHeld();
        },
      },
    };
  }

  #schedule(): ScheduleSummary | null {
    const schedule = this.#presenter?.schedule ?? null;
    if (schedule === null) return null;
    return {
      durationMs: schedule.durationMs,
      groups: schedule.groups.map(({ kind, startMs, endMs, unit }) => ({ kind, startMs, endMs, unit })),
      segments: schedule.segments.map(({ kind, group, startMs, endMs }) => ({ kind, group, startMs, endMs })),
      bigWinLevel: schedule.bigWinLevel,
    };
  }

  #labOrThrow(): ProbeLab {
    if (this.#lab === null) throw new Error('лаборатория сети не связана');
    return this.#lab;
  }
}
