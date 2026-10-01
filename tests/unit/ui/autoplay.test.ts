import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControllerSnapshot, Presentation, PresentationListener, ShownRound } from '../../../src/client/index.ts';
import { AUTOPLAY_PAUSE_MS, AUTOPLAY_PLAQUE_MS, Autoplay, DEFAULT_AUTOPLAY, type AutoplayGame, type AutoplayOptions } from '../../../src/ui/autoplay.ts';
import { ClientWorld, type Tab } from '../../support/client-world.ts';
import { plant } from '../../support/rgs-rig.ts';

// Автоигра (§11, решение 4 фазы 7) над настоящим контроллером и сервером в памяти: только жмёт «Спін» и тап по плашке;
// останавливается с причиной. Сиды сервера: 0 — small-win (0.95×), 1 — проигрыш, 2 — base-win (1.90×), 48 — фича.

const schedule = (ms: number, task: () => void): (() => void) => {
  const id = setTimeout(task, ms);
  return () => {
    clearTimeout(id);
  };
};

/** Показ: раунд с фичей встаёт на плашке (held), тап «продолжить» доводит до конца; остальные — сразу. */
class HoldingPresentation implements Presentation {
  readonly log: string[] = [];
  #listener: PresentationListener | null = null;

  listen(listener: PresentationListener): void {
    this.#listener = listener;
  }

  play(round: ShownRound): void {
    const feature = round.events.some((event) => event.t === 'fsStart');
    this.log.push(feature ? `held ${round.roundId}` : `play ${round.roundId}`);
    if (feature) this.#listener?.held();
    else this.#listener?.finished();
  }

  rest(): void {
    // Сетка покоя показу без часов не нужна.
  }

  skip(): void {
    this.log.push('skip');
  }

  resume(): void {
    this.log.push('resume');
    this.#listener?.finished();
  }

  halt(): void {
    this.log.push('halt');
  }
}

async function settle(ms = 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function plays(tab: Tab): number {
  return tab.port.received.filter((body) => body.type === 'play').length;
}

function series(tab: Tab, allowed: () => boolean = () => true): Autoplay {
  return new Autoplay(tab.controller, schedule, allowed);
}

const options = (overrides: Partial<AutoplayOptions> = {}): AutoplayOptions => ({ ...DEFAULT_AUTOPLAY, ...overrides });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Autoplay', () => {
  it('умолчания: 10 спинов, лимит потерь 10 ставок, остановка на фиче — да, на выигрыше — нет', () => {
    expect(DEFAULT_AUTOPLAY).toStrictEqual({ count: 10, lossLimitBets: 10, stopOnFeature: true, stopOnWinX: null });
    expect([AUTOPLAY_PAUSE_MS, AUTOPLAY_PLAQUE_MS]).toStrictEqual([400, 800]);
  });

  it('серия до конца: ровно count спинов, между ними пауза; полоса — «все спины сыграны»', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [0] });
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 10 }));
    expect(autoplay.getSnapshot()).toStrictEqual({ kind: 'running', left: 9 });
    await settle(AUTOPLAY_PAUSE_MS - 20);
    expect(plays(a)).toBe(1);
    await settle(10 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), autoplay.getSnapshot()]).toStrictEqual([10, { kind: 'stopped', reason: 'done' }]);
    await settle(2 * AUTOPLAY_PAUSE_MS);
    expect(plays(a)).toBe(10);
    autoplay.dismiss();
    expect(autoplay.getSnapshot()).toStrictEqual({ kind: 'off' });
  });

  it('лимит потерь: при потере 3 ставок новый спин не уходит', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [1] });
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 25, lossLimitBets: 3 }));
    await settle(10 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), a.snapshot.balanceMinor, autoplay.getSnapshot()]).toStrictEqual([3, 99_700, { kind: 'stopped', reason: 'lossLimit' }]);
  });

  it('фича: плашку серия продолжает сама через паузу; остановка на фиче — после её раунда', async () => {
    const world = new ClientWorld();
    const presentation = new HoldingPresentation();
    const a = world.open('a', { seeds: [48], presentation });
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 10 }));
    await settle();
    expect(a.state.name).toBe('featureIntro');
    await settle(AUTOPLAY_PLAQUE_MS - 20);
    expect(presentation.log).toStrictEqual(['held ar1']);
    await settle(30);
    expect(presentation.log).toStrictEqual(['held ar1', 'resume']);
    await settle(4 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), autoplay.getSnapshot()]).toStrictEqual([1, { kind: 'stopped', reason: 'feature' }]);
  });

  it('фича без остановки на ней: серия идёт дальше', async () => {
    const world = new ClientWorld();
    const presentation = new HoldingPresentation();
    const a = world.open('a', { seeds: [48, 0], presentation });
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 10, stopOnFeature: false }));
    await settle(5 * AUTOPLAY_PLAQUE_MS + 12 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), presentation.log.filter((entry) => entry === 'resume').length, autoplay.getSnapshot()]).toStrictEqual([
      10,
      5,
      { kind: 'stopped', reason: 'done' },
    ]);
  });

  it('выигрыш от N×: 1.90× при N = 1.5 — остановка; при N = 2 — серия идёт', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [2] });
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 10, stopOnWinX: 1.5 }));
    await settle(4 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), autoplay.getSnapshot()]).toStrictEqual([1, { kind: 'stopped', reason: 'bigWin' }]);
    const b = world.open('b', { seeds: [2] });
    await settle();
    const other = series(b);
    other.start(options({ count: 10, stopOnWinX: 2 }));
    await settle(12 * AUTOPLAY_PAUSE_MS);
    expect([plays(b), other.getSnapshot()]).toStrictEqual([10, { kind: 'stopped', reason: 'done' }]);
    // «От N×» включительно: 1.90× при N = 1.9.
    const c = world.open('c', { seeds: [2] });
    await settle();
    const exact = series(c);
    exact.start(options({ count: 10, stopOnWinX: 1.9 }));
    await settle(4 * AUTOPLAY_PAUSE_MS);
    expect([plays(c), exact.getSnapshot()]).toStrictEqual([1, { kind: 'stopped', reason: 'bigWin' }]);
  });

  it('ошибка: запросы теряются, повторы кончились — экран ошибки, серия встала', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [0] });
    await settle();
    a.lab.set({ requestLoss: 1 });
    const autoplay = series(a);
    autoplay.start(options({ count: 10 }));
    await settle(30_000);
    expect([a.state.name, autoplay.getSnapshot()]).toStrictEqual(['error', { kind: 'stopped', reason: 'error' }]);
  });

  it('нехватка средств: сервер отказал спину — серия встала с причиной, денег не тронуто', async () => {
    const world = new ClientWorld();
    await plant(world.storage, [
      { op: 'put', store: 'wallet', value: { id: 'main', balanceMinor: 150, activeRoundId: null, nextSeq: 1, revision: 3, resetSeq: 1 } },
    ]);
    const a = world.open('a', { seeds: [1] });
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 10 }));
    await settle(4 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), a.snapshot.balanceMinor, autoplay.getSnapshot()]).toStrictEqual([2, 50, { kind: 'stopped', reason: 'funds' }]);
  });

  it('раунд держит другая вкладка: спин не ушёл — серия встала с причиной, а не молча', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [0] });
    const b = world.open('b', { seeds: [0] });
    await settle();
    b.lab.holdNextEndRound();
    b.controller.spin();
    await settle();
    const autoplay = series(a);
    autoplay.start(options({ count: 10 }));
    await settle();
    expect([a.state.name, plays(a), autoplay.getSnapshot()]).toStrictEqual(['waitingForTab', 0, { kind: 'stopped', reason: 'otherTab' }]);
  });

  it('пресет без автоигры: серия не стартует; выбран посреди серии — следующий спин не уходит', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [0] });
    await settle();
    let allowed = false;
    const autoplay = series(a, () => allowed);
    autoplay.start(options());
    expect([autoplay.getSnapshot(), plays(a)]).toStrictEqual([{ kind: 'off' }, 0]);
    allowed = true;
    autoplay.start(options());
    await settle();
    allowed = false;
    await settle(4 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), autoplay.getSnapshot()]).toStrictEqual([1, { kind: 'stopped', reason: 'player' }]);
  });

  it('игрок остановил: дальше ни одного спина; вторая серия — заново', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [0] });
    await settle();
    const autoplay = series(a);
    autoplay.start(options());
    await settle();
    autoplay.stop();
    await settle(4 * AUTOPLAY_PAUSE_MS);
    expect([plays(a), autoplay.getSnapshot()]).toStrictEqual([1, { kind: 'stopped', reason: 'player' }]);
    autoplay.start(options({ count: 10 }));
    await settle(12 * AUTOPLAY_PAUSE_MS);
    expect(plays(a)).toBe(11);
  });

  it('не стартует: не покой, повтор по ссылке, лимит потерь не целое от 1; спин не принят — «отказ»', async () => {
    const world = new ClientWorld();
    const a = world.open('a', { seeds: [0] });
    const autoplay = series(a);
    autoplay.start(options());
    expect(autoplay.getSnapshot()).toStrictEqual({ kind: 'off' });
    await settle();
    for (const lossLimitBets of [0, 1.5, Number.NaN]) autoplay.start(options({ lossLimitBets }));
    expect([autoplay.getSnapshot(), plays(a)]).toStrictEqual([{ kind: 'off' }, 0]);
    const replay = world.replay('r', { book: 0 });
    await settle();
    const inReplay = series(replay);
    inReplay.start(options());
    expect([replay.calls, inReplay.getSnapshot()]).toStrictEqual([['replay'], { kind: 'off' }]);
    // Игра, которая спин не принимает: снимок покоя тот же — серия встаёт с причиной.
    const snapshot: ControllerSnapshot = a.snapshot;
    const deaf: AutoplayGame = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      spin: () => undefined,
      tap: () => undefined,
      onRoundSettled: (): (() => void) => () => undefined,
    };
    const refused = new Autoplay(deaf, schedule, () => true);
    refused.start(options());
    expect(refused.getSnapshot()).toStrictEqual({ kind: 'stopped', reason: 'refused' });
  });
});
