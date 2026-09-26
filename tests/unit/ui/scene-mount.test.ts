import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RendererInfo, RendererLifecycle } from '../../../src/render/renderer.ts';
import { SceneMount } from '../../../src/ui/scene-mount.ts';

// Поддельный рендерер: init ждёт, пока тест не разрешит или не отвергнет его. Двойной destroy — ошибка.
const HOST = {} as HTMLElement;
const INFO: RendererInfo = { name: 'webgl', gpu: 'fake' };

class InjectedFailure extends Error {}

class FakeRenderer implements RendererLifecycle {
  readonly id: number;
  readonly #log: string[];
  destroyed = 0;
  initialised = false;
  failed = false;
  #settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;

  constructor(id: number, log: string[]) {
    this.id = id;
    this.#log = log;
  }

  get pending(): boolean {
    return this.#settle !== null;
  }

  init(): Promise<RendererInfo> {
    this.#log.push(`init#${String(this.id)}`);
    return new Promise<RendererInfo>((resolve, reject) => {
      this.#settle = {
        resolve: () => {
          this.initialised = true;
          resolve(INFO);
        },
        reject,
      };
    });
  }

  resolveInit(): void {
    const settle = this.#settle;
    this.#settle = null;
    settle?.resolve();
  }

  rejectInit(): void {
    const settle = this.#settle;
    this.#settle = null;
    if (settle !== null) this.failed = true;
    settle?.reject(new InjectedFailure(`init#${String(this.id)}`));
  }

  destroy(): void {
    if (this.destroyed > 0) throw new Error(`двойной destroy #${String(this.id)}`);
    this.destroyed += 1;
    this.#log.push(`destroy#${String(this.id)}`);
  }
}

class Harness {
  readonly log: string[] = [];
  readonly renderers: FakeRenderer[] = [];
  readonly ready: FakeRenderer[] = [];
  readonly errors: unknown[] = [];
  readonly mount: SceneMount<FakeRenderer>;

  constructor() {
    this.mount = new SceneMount<FakeRenderer>(
      () => {
        const renderer = new FakeRenderer(this.renderers.length + 1, this.log);
        this.renderers.push(renderer);
        this.log.push(`create#${String(renderer.id)}`);
        return renderer;
      },
      (renderer) => this.ready.push(renderer),
      (error) => this.errors.push(error),
    );
  }

  get alive(): number {
    return this.renderers.filter((renderer) => renderer.destroyed === 0).length;
  }

  renderer(id: number): FakeRenderer {
    const renderer = this.renderers[id - 1];
    if (renderer === undefined) throw new Error(`рендерера #${String(id)} нет`);
    return renderer;
  }
}

/** Промисы цепочки — микрозадачи; setImmediate идёт после всех. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SceneMount — сценарии', () => {
  it('StrictMode: attach → detach → attach синхронно — создаётся один рендерер', async () => {
    const h = new Harness();
    h.mount.attach(HOST);
    h.mount.detach();
    h.mount.attach(HOST);
    await flush();
    h.renderer(1).resolveInit();
    await flush();
    expect(h.log).toStrictEqual(['create#1', 'init#1']);
    expect(h.mount.renderer).toBe(h.renderer(1));
    expect(h.ready).toStrictEqual([h.renderer(1)]);
  });

  it('размонтировались во время await init — рендерер уничтожается сразу по возврату', async () => {
    const h = new Harness();
    h.mount.attach(HOST);
    await flush();
    h.mount.detach();
    expect(h.renderer(1).destroyed).toBe(0);
    h.renderer(1).resolveInit();
    await flush();
    expect(h.renderer(1).destroyed).toBe(1);
    expect(h.mount.renderer).toBeNull();
    expect(h.ready).toStrictEqual([]);
  });

  it('новое монтирование ждёт, пока предыдущий рендерер не дойдёт до конца init и не будет уничтожен', async () => {
    const h = new Harness();
    h.mount.attach(HOST);
    await flush();
    h.mount.detach();
    h.mount.attach(HOST);
    await flush();
    expect(h.renderers).toHaveLength(1);
    h.renderer(1).resolveInit();
    await flush();
    expect(h.log).toStrictEqual(['create#1', 'init#1', 'destroy#1', 'create#2', 'init#2']);
    h.renderer(2).resolveInit();
    await flush();
    expect(h.mount.renderer).toBe(h.renderer(2));
    expect(h.alive).toBe(1);
  });

  it('детач живого рендерера уничтожает его синхронно', async () => {
    const h = new Harness();
    h.mount.attach(HOST);
    await flush();
    h.renderer(1).resolveInit();
    await flush();
    h.mount.detach();
    expect(h.renderer(1).destroyed).toBe(1);
    expect(h.mount.renderer).toBeNull();
  });

  it('init упал — рендерер уничтожен, ошибка сообщена один раз, следующее монтирование проходит', async () => {
    const h = new Harness();
    h.mount.attach(HOST);
    await flush();
    h.renderer(1).rejectInit();
    await flush();
    expect(h.renderer(1).destroyed).toBe(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(InjectedFailure);
    h.mount.detach();
    h.mount.attach(HOST);
    await flush();
    h.renderer(2).resolveInit();
    await flush();
    expect(h.mount.renderer).toBe(h.renderer(2));
  });

  it('init упал уже после размонтирования — рендерер уничтожен, ошибка устаревшего монтирования не сообщается', async () => {
    const h = new Harness();
    h.mount.attach(HOST);
    await flush();
    h.mount.detach();
    h.renderer(1).rejectInit();
    await flush();
    expect(h.renderer(1).destroyed).toBe(1);
    expect(h.errors).toStrictEqual([]);
  });

  it('attach без detach — ошибка программиста', () => {
    const h = new Harness();
    h.mount.attach(HOST);
    expect(() => {
      h.mount.attach(HOST);
    }).toThrow(/attach без detach/);
  });
});

type Command = 'toggle' | 'resolve' | 'reject';

describe('SceneMount — свойства на случайных перемежениях', () => {
  it('живых не больше одного; в конце — один при монтировании (ноль, если его init упал), ноль без него; destroy не дважды', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom<Command>('toggle', 'resolve', 'reject'), { maxLength: 40 }), async (commands) => {
        const h = new Harness();
        let attached = false;
        for (const command of commands) {
          const pending = h.renderers.find((renderer) => renderer.pending);
          if (command === 'toggle') {
            if (attached) h.mount.detach();
            else h.mount.attach(HOST);
            attached = !attached;
          } else if (command === 'resolve') pending?.resolveInit();
          else pending?.rejectInit();
          await flush();
          if (h.alive > 1) return false;
          if (!attached && h.mount.renderer !== null) return false;
        }
        // Доводим все init до конца: без отказов.
        for (let guard = 0; guard < 100; guard++) {
          const pending = h.renderers.find((renderer) => renderer.pending);
          if (pending === undefined) break;
          pending.resolveInit();
          await flush();
          if (h.alive > 1) return false;
        }
        const onlyInjected = h.errors.every((error) => error instanceof InjectedFailure);
        if (!onlyInjected) return false;
        if (!attached) return h.alive === 0 && h.mount.renderer === null;
        const last = h.renderers.at(-1);
        if (last === undefined) return false;
        if (last.failed) return h.alive === 0 && h.mount.renderer === null && h.errors.length > 0;
        return h.alive === 1 && h.mount.renderer === last && last.initialised;
      }),
    );
  });
});
