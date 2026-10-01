import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { ForcedName } from '../../src/ui/forced-rounds.ts';
import { writeMeasure } from '../gpu/support/phase9.ts';
import { installTextureCounter, type TextureCounts } from '../gpu/support/texture-counter.ts';
import { heapObjectBytes } from './heap-objects.ts';
import { waitForState } from '../support/game-page.ts';
import { collectConsole, sceneInfo, type ProbeWindow } from '../support/page-probe.ts';

// Память за 300 спинов (§13, фаза 9): турбо и автопропуск, спины — клик «Спін» в странице (синтетический ввод приводит
// игру в состояние). Первые семь спинов — принудительные крупные раунды (кап, ретриггер, большие выигрыши, множитель,
// фича, каскад): пулы по высшей отметке — контексты контуров, пулы Pixi, осколки — доходят до верха до отметки 50; иначе
// крупный раунд, выпавший между 50-м и 300-м, прибавлял их рост к проверке (проба: без прогрева 1.2–4.8%, с ним
// 0.84–1.24% — почти весь остаток — журналы самого зонда, ~180 Б на спин). На 50-м и 300-м спине — сборка мусора через CDP (HeapProfiler.collectGarbage, дважды), снимок кучи
// страницы и воркера (воркер — его цель CDP через Target.sendMessageToTarget: performance.memory в воркере нет) и
// объекты кучи по снимку (heap-objects.ts: без кода JIT и внутренних кэшей движка); живые текстуры — созданные минус
// удалённые на границе API. Объекты кучи ≤ +5% к 50-му, живых текстур не больше; оба рендерера. Сырая usedSize
// (Runtime.getHeapUsage) — в отчёт: её рост между 50-м и 300-м — прогрев JIT (проба: +450 КБ кода страницы на 250
// спинах, объектов — +60 КБ). Это же закрывает заметку §15: дробное время декора и тепло в background.update и
// frame.update не копят объектов в куче. Положительный контроль — ?memleak=1 (только dev и e2e): зонд держит массив
// 64 КБ и текстуру на каждый раунд, воркер — свой массив 64 КБ; на 50 → 150 спинах все три проверки краснеют.

const GROWTH = 1.05;
/** Прогрев пулов до отметки 50: самые крупные раунды — первыми. */
const WARM_UP: readonly ForcedName[] = ['maxWin', 'retrigger', 'bigWin3', 'bigWin2', 'multiplier', 'feature', 'cascade'];

type CountWindow = ProbeWindow & { __textureCounts?: TextureCounts };

/** Куча одной стороны: объекты по снимку и сырая usedSize. */
interface Side {
  readonly objects: number;
  readonly used: number;
}

interface Heaps {
  readonly page: Side;
  readonly worker: Side;
  readonly liveTextures: number;
}

/** Сессия CDP воркера игры через сессию страницы: сообщения цели — Target.sendMessageToTarget без flatten. */
class WorkerSession {
  readonly #cdp: CDPSession;
  readonly #sessionId: string;
  readonly #pending = new Map<number, (reply: Record<string, unknown>) => void>();
  #chunks: string[] = [];
  #next = 1;

  private constructor(cdp: CDPSession, sessionId: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      if (event.sessionId !== sessionId) return;
      const reply = JSON.parse(event.message) as Record<string, unknown>;
      if (reply['method'] === 'HeapProfiler.addHeapSnapshotChunk') this.#chunks.push((reply['params'] as { chunk: string }).chunk);
      const id = typeof reply['id'] === 'number' ? reply['id'] : null;
      if (id !== null) this.#pending.get(id)?.(reply);
    });
  }

  static async attach(cdp: CDPSession): Promise<WorkerSession> {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter((target) => target.type === 'worker' && target.url.includes('/assets/worker'));
    expect(workers, 'воркер игры — одна цель CDP').toHaveLength(1);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: workers[0]?.targetId ?? '', flatten: false });
    return new WorkerSession(cdp, sessionId);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      void this.#cdp.send('Target.sendMessageToTarget', { sessionId: this.#sessionId, message: JSON.stringify({ id, method, params }) });
    });
  }

  /** Снимок кучи воркера: куски приходят сообщениями цели до ответа на takeHeapSnapshot. */
  async snapshot(): Promise<string> {
    this.#chunks = [];
    await this.call('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    return this.#chunks.join('');
  }

  async usedHeap(): Promise<number> {
    const reply = await this.call('Runtime.getHeapUsage');
    const result = reply['result'] as { usedSize?: unknown } | undefined;
    if (typeof result?.usedSize !== 'number') throw new Error(`куча воркера: ${JSON.stringify(reply)}`);
    return result.usedSize;
  }
}

async function pageSnapshot(cdp: CDPSession): Promise<string> {
  const chunks: string[] = [];
  const collect = (event: { chunk: string }): void => {
    chunks.push(event.chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
  return chunks.join('');
}

async function heaps(page: Page, cdp: CDPSession, worker: WorkerSession): Promise<Heaps> {
  await page.waitForTimeout(500);
  for (let pass = 0; pass < 2; pass++) {
    await cdp.send('HeapProfiler.collectGarbage');
    await worker.call('HeapProfiler.collectGarbage');
  }
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const pageSide = { objects: heapObjectBytes(await pageSnapshot(cdp)), used: usedSize };
  const workerUsed = await worker.usedHeap();
  const workerSide = { objects: heapObjectBytes(await worker.snapshot()), used: workerUsed };
  const counts = await page.evaluate(() => (window as CountWindow).__textureCounts ?? null);
  if (counts === null) throw new Error('счётчик текстур не установлен');
  expect(pageSide.objects, 'объекты кучи страницы посчитаны').toBeGreaterThan(0);
  expect(workerSide.objects, 'объекты кучи воркера посчитаны').toBeGreaterThan(0);
  return { page: pageSide, worker: workerSide, liveTextures: counts.created - counts.destroyed };
}

const growth = (from: number, to: number): string => `${((to / from - 1) * 100).toFixed(2)}%`;
const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(2);

function describe(at: Heaps, later: Heaps): string {
  return (
    `страница: объекты ${mb(at.page.objects)} → ${mb(later.page.objects)} МБ (${growth(at.page.objects, later.page.objects)}), usedSize ${mb(at.page.used)} → ${mb(later.page.used)} (${growth(at.page.used, later.page.used)}); ` +
    `воркер: объекты ${mb(at.worker.objects)} → ${mb(later.worker.objects)} МБ (${growth(at.worker.objects, later.worker.objects)}), usedSize ${mb(at.worker.used)} → ${mb(later.worker.used)} (${growth(at.worker.used, later.worker.used)}); ` +
    `живых текстур ${String(at.liveTextures)} → ${String(later.liveTextures)}`
  );
}

/**
 * Спины до goal показанных раундов — клик «Спін» в странице и ожидание покоя (автопропуск ведёт показ); первые спины —
 * принудительные раунды WARM_UP.
 */
async function spinsTo(page: Page, goal: number): Promise<void> {
  await page.evaluate(async ({ target, warmUp }) => {
    const probe = (window as ProbeWindow).__cryscadeProbe;
    const spin = document.querySelector<HTMLButtonElement>('button.spin');
    if (probe === undefined || spin === null) throw new Error('нет зонда или «Спін»');
    const until = (check: () => boolean): Promise<void> =>
      new Promise((resolve, reject) => {
        const started = performance.now();
        const poll = (): void => {
          if (check()) resolve();
          else if (performance.now() - started > 60_000) reject(new Error(`игра не пришла в покой за минуту: ${JSON.stringify(probe.game()?.state)}`));
          else window.setTimeout(poll, 5);
        };
        poll();
      });
    const idle = (): boolean => probe.game()?.state.name === 'idle';
    while (probe.shownRounds().length < target) {
      await until(idle);
      const before = probe.shownRounds().length;
      const forced = warmUp[before];
      if (forced !== undefined) await probe.force(forced);
      spin.click();
      await until(() => probe.shownRounds().length > before && idle());
    }
  }, { target: goal, warmUp: WARM_UP });
}

interface Session {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly worker: WorkerSession;
  readonly gpu: string;
  readonly problems: string[];
}

async function openSession(page: Page, renderer: 'webgl' | 'webgpu', leak: boolean): Promise<Session> {
  const { problems } = collectConsole(page);
  await page.addInitScript(installTextureCounter);
  await page.goto(`./?renderer=${renderer}&autoskip=1${leak ? '&memleak=1' : ''}`);
  await waitForState(page, 'idle');
  const info = await sceneInfo(page);
  expect(info.name, 'фактический рендерер').toBe(renderer);
  expect(info.software, `программный рендер — не мерим: ${info.gpu}`).toBe(false);
  const turbo = page.getByRole('button', { name: 'Турбо' });
  await turbo.click();
  await expect(turbo).toHaveAttribute('aria-pressed', 'true');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  return { page, cdp, worker: await WorkerSession.attach(cdp), gpu: info.gpu, problems };
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  test(`${renderer}: 300 спинов в турбо с автопропуском — куча страницы и воркера ≤ +5% к 50-му, живых текстур не больше`, async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const session = await openSession(page, renderer, false);
    await spinsTo(page, 50);
    const at50 = await heaps(page, session.cdp, session.worker);
    await spinsTo(page, 300);
    const at300 = await heaps(page, session.cdp, session.worker);
    console.log(`${renderer} (${session.gpu}), 50 → 300: ${describe(at50, at300)}`);
    writeMeasure(`memory-${renderer}`, { renderer, gpu: session.gpu, spins: [50, 300], at50, at300 });
    expect(at300.page.objects, 'объекты кучи страницы на 300-м — не больше +5% к 50-му').toBeLessThanOrEqual(at50.page.objects * GROWTH);
    expect(at300.worker.objects, 'объекты кучи воркера на 300-м — не больше +5% к 50-му').toBeLessThanOrEqual(at50.worker.objects * GROWTH);
    expect(at300.liveTextures, 'живых текстур не прибавилось').toBeLessThanOrEqual(at50.liveTextures);
    expect(at50.liveTextures, 'текстуры сцены посчитаны').toBeGreaterThan(0);
    expect(session.problems).toEqual([]);
  });

  test(`${renderer}: контроль — ?memleak=1, 50 → 150 спинов: куча страницы и воркера выросла больше 5%, живых текстур больше`, async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const session = await openSession(page, renderer, true);
    await spinsTo(page, 50);
    const at50 = await heaps(page, session.cdp, session.worker);
    await spinsTo(page, 150);
    const at150 = await heaps(page, session.cdp, session.worker);
    console.log(`${renderer}, контроль ?memleak=1, 50 → 150: ${describe(at50, at150)}`);
    writeMeasure(`memory-control-${renderer}`, { renderer, gpu: session.gpu, spins: [50, 150], at50, at150 });
    expect(at150.page.objects, 'контроль: проверка кучи страницы краснеет').toBeGreaterThan(at50.page.objects * GROWTH);
    expect(at150.worker.objects, 'контроль: проверка кучи воркера краснеет').toBeGreaterThan(at50.worker.objects * GROWTH);
    expect(at150.liveTextures, 'контроль: проверка текстур краснеет').toBeGreaterThan(at50.liveTextures);
    expect(session.problems).toEqual([]);
  });
}
