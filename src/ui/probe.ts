// Тестовый зонд страницы — только dev и e2e-сборка (ui/main.tsx грузит его динамически под условием сборки).
// В прод-бандле его нет: tests/e2e/bundle.spec.ts ищет маркеры в dist/ и, положительным контролем, в dist-e2e/.

import type { ControllerSnapshot, LabSettings, Transport } from '../client/index.ts';
import { SceneProbe } from '../render/pixi/inspector.ts';
import type { CryscadeProbe, MountCounts, ProbeLab, SentBody } from './probe-api.ts';
import type { MountObserver } from './scene-session.ts';

/** Что зонду нужно от контроллера: снимок и подписка. */
interface GameView {
  getSnapshot(): ControllerSnapshot;
  subscribe(listener: () => void): () => void;
}

/** Раунд, который показывает вкладка: показ, доигрывание и его endRound. */
function shownRoundId(state: ControllerSnapshot['state']): string | null {
  switch (state.name) {
    case 'presenting':
    case 'ending':
      return state.roundId;
    case 'restoring':
      return state.roundId;
    default:
      return null;
  }
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
  readonly #shown: string[] = [];
  readonly #sent: SentBody[] = [];
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
    });
  }

  /** Транспорт до воркера с журналом: что ушло после лаборатории сети, то дошло до сервера. */
  record(inner: Transport): Transport {
    return {
      send: (message) => {
        const body = bodyOf(message);
        if (body !== null) this.#sent.push(body);
        inner.send(message);
      },
      listen: (listener) => inner.listen(listener),
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
      game: () => this.#game?.getSnapshot() ?? null,
      shownRounds: () => [...this.#shown],
      sent: () => [...this.#sent],
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

  #labOrThrow(): ProbeLab {
    if (this.#lab === null) throw new Error('лаборатория сети не связана');
    return this.#lab;
  }
}
