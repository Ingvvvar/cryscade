// Тестовый зонд страницы — только dev и e2e-сборка (ui/main.tsx грузит его динамически под условием сборки).
// В прод-бандле его нет: tests/e2e/bundle.spec.ts ищет маркеры в dist/ и, положительным контролем, в dist-e2e/.

import { SceneProbe } from '../render/pixi/inspector.ts';
import type { CryscadeProbe, MountCounts } from './probe-api.ts';
import type { MountObserver } from './scene-session.ts';

export class PageProbe implements MountObserver {
  readonly scene = new SceneProbe();
  #attaches = 0;
  #detaches = 0;
  #created = 0;
  readonly #errors: string[] = [];
  #remount: (() => void) | null = null;

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
    };
  }
}
