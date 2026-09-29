import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAR_NETWORK } from '../../src/client/index.ts';
import { ClientWorld, type Tab } from '../support/client-world.ts';
import { audit } from '../support/wallet-world.ts';

// Вкладки на контроллерах (§6.3, §6.5): от одной до трёх вкладок на общем профиле открываются и закрываются, крутят,
// жмут «Повторити» и «Грати тут», теряют запросы и ответы, задерживают endRound, ждут. Потом сеть успокаивается,
// ошибки повторяются, и открывается свежая вкладка — она доигрывает брошенное. В конце:
// - сверка кошелька из шага А: баланс = 1000 − Σ ставок + Σ выигрышей закрытых раундов, ключ → не больше раунда;
// - активных раундов нет, замок раунда свободен;
// - каждая вкладка в idle и показывает баланс кошелька — порядок по revision сошёлся у всех;
// - у RgsClient каждой вкладки ни одной ждущей попытки: брошенные не копятся в памяти.

type Action =
  | { readonly kind: 'open'; readonly seeds: readonly number[] }
  | { readonly kind: 'close' | 'spin' | 'retry' | 'takeOver' | 'lose' | 'hold' | 'release'; readonly tab: number }
  /** Спин, у которого пропали все запросы (stall) или все ответы (mute): вкладка на экране ошибки, замок у неё. */
  | { readonly kind: 'stall' | 'mute'; readonly tab: number }
  | { readonly kind: 'net'; readonly tab: number; readonly requestLoss: number; readonly responseLoss: number; readonly latencyMs: number }
  | { readonly kind: 'wait'; readonly ms: number };

const SEED = fc.constantFrom(1, 1, 1, 0, 2, 512, 48);
const TAB = fc.nat(5);
const ACTION: fc.Arbitrary<Action> = fc.oneof(
  { weight: 1, arbitrary: fc.array(SEED, { minLength: 1, maxLength: 4 }).map((seeds): Action => ({ kind: 'open', seeds })) },
  { weight: 1, arbitrary: TAB.map((tab): Action => ({ kind: 'close', tab })) },
  { weight: 6, arbitrary: TAB.map((tab): Action => ({ kind: 'spin', tab })) },
  { weight: 2, arbitrary: TAB.map((tab): Action => ({ kind: 'retry', tab })) },
  { weight: 3, arbitrary: TAB.map((tab): Action => ({ kind: 'takeOver', tab })) },
  { weight: 1, arbitrary: TAB.map((tab): Action => ({ kind: 'lose', tab })) },
  { weight: 3, arbitrary: TAB.map((tab): Action => ({ kind: 'hold', tab })) },
  { weight: 2, arbitrary: TAB.map((tab): Action => ({ kind: 'stall', tab })) },
  { weight: 2, arbitrary: TAB.map((tab): Action => ({ kind: 'mute', tab })) },
  { weight: 1, arbitrary: TAB.map((tab): Action => ({ kind: 'release', tab })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ tab: TAB, requestLoss: fc.constantFrom(0, 1), responseLoss: fc.constantFrom(0, 1), latencyMs: fc.constantFrom(0, 0, 1000, 3500) })
      .map((net): Action => ({ kind: 'net', ...net })),
  },
  { weight: 3, arbitrary: fc.constantFrom(0, 50, 1000, 3300, 20_000).map((ms): Action => ({ kind: 'wait', ms })) },
);

interface Seen {
  closedRounds: number;
  steals: number;
  restores: number;
  errors: number;
  waits: number;
}

async function run(actions: readonly Action[], seen: Seen): Promise<string[]> {
  const world = new ClientWorld();
  const tabs: Tab[] = [];
  const all: Tab[] = [];
  let opened = 0;
  const open = (seeds: readonly number[]): Tab => {
    opened += 1;
    const tab = world.open(`t${String(opened)}-`, { seeds });
    tabs.push(tab);
    all.push(tab);
    return tab;
  };
  const pick = (index: number): Tab | undefined => tabs[index % Math.max(1, tabs.length)];
  /** Первая вкладка в нужном состоянии, начиная с index по кругу; нет такой — просто по index. */
  const pickIn = (index: number, state: string): Tab | undefined => {
    for (let step = 0; step < tabs.length; step++) {
      const tab = tabs[(index + step) % tabs.length];
      if (tab?.state.name === state) return tab;
    }
    return pick(index);
  };
  open([1, 0]);
  open([0, 2]);
  for (const action of actions) {
    switch (action.kind) {
      case 'open':
        if (tabs.length < 3) open(action.seeds);
        break;
      case 'close': {
        const tab = pick(action.tab);
        if (tab !== undefined) {
          tabs.splice(tabs.indexOf(tab), 1);
          tab.close();
        }
        break;
      }
      case 'spin':
        pickIn(action.tab, 'idle')?.controller.spin();
        break;
      case 'retry':
        pickIn(action.tab, 'error')?.controller.retry();
        break;
      case 'takeOver':
        pickIn(action.tab, 'waitingForTab')?.controller.takeOver();
        break;
      case 'lose':
        pick(action.tab)?.lab.loseNextResponse();
        break;
      case 'hold':
        pick(action.tab)?.lab.holdNextEndRound();
        break;
      case 'release':
        pick(action.tab)?.lab.releaseHeld();
        break;
      case 'net':
        pick(action.tab)?.lab.set({ requestLoss: action.requestLoss, responseLoss: action.responseLoss, latencyMs: action.latencyMs });
        break;
      case 'stall':
      case 'mute': {
        const tab = pickIn(action.tab, 'idle');
        if (tab === undefined) break;
        tab.lab.set(action.kind === 'stall' ? { requestLoss: 1 } : { responseLoss: 1 });
        tab.controller.spin();
        await vi.advanceTimersByTimeAsync(19_000);
        tab.lab.set(CLEAR_NETWORK);
        break;
      }
      case 'wait':
        await vi.advanceTimersByTimeAsync(action.ms);
        break;
    }
    await vi.advanceTimersByTimeAsync(0);
  }

  // Сеть успокоилась: задержанное отпущено, ошибки повторены, свежая вкладка доигрывает брошенное.
  for (const tab of tabs) {
    tab.lab.set(CLEAR_NETWORK);
    tab.lab.releaseHeld();
  }
  await vi.advanceTimersByTimeAsync(60_000);
  for (let round = 0; round < 3; round++) {
    for (const tab of tabs) tab.controller.retry();
    await vi.advanceTimersByTimeAsync(60_000);
  }
  open([1]);
  await vi.advanceTimersByTimeAsync(60_000);

  for (const tab of all) {
    for (const snapshot of tab.snapshots) {
      if (snapshot.state.name === 'waitingForTab') {
        seen.waits += 1;
        if (snapshot.state.stealing) seen.steals += 1;
      }
      if (snapshot.state.name === 'error') seen.errors += 1;
    }
  }
  const snapshot = world.storage.snapshot();
  // Доигрывание: вкладка закрыла раунд, сыгранный чужим ключом. Показ в фазе 4 мгновенный, restoring{show} в снимок
  // не попадает — считаем по запросам.
  const keyOf = new Map(snapshot.rounds.map(([, round]) => [(round as { roundId: string }).roundId, (round as { idempotencyKey: string }).idempotencyKey]));
  for (const tab of all) {
    for (const body of tab.port.received) {
      if (body.type === 'endRound' && keyOf.get(body.roundId)?.startsWith(tab.name) === false) seen.restores += 1;
    }
  }
  const problems = audit(snapshot);
  const wallet = snapshot.wallet[0]?.[1] as { balanceMinor: number; activeRoundId: string | null } | undefined;
  const rounds = snapshot.rounds.map(([, round]) => round as { roundId: string; status: string });
  seen.closedRounds += rounds.filter((round) => round.status === 'closed').length;
  if (wallet?.activeRoundId != null) problems.push(`активный раунд ${wallet.activeRoundId} остался`);
  for (const round of rounds) if (round.status !== 'closed') problems.push(`${round.roundId} не закрыт`);
  if (!(await world.lockFree())) problems.push('замок раунда занят');
  for (const tab of tabs) {
    const view = tab.snapshot;
    if (view.state.name !== 'idle') problems.push(`вкладка в ${JSON.stringify(view.state)}`);
    if (view.balanceMinor !== (wallet?.balanceMinor ?? 100_000)) {
      problems.push(`вкладка показывает ${String(view.balanceMinor)}, кошелёк — ${String(wallet?.balanceMinor)}`);
    }
    // Потерянные попытки не копятся: всё отыграно — ждущих нет.
    if (tab.client.pendingAttempts !== 0) problems.push(`у вкладки ${String(tab.client.pendingAttempts)} ждущих попыток`);
  }
  for (const tab of tabs) tab.close();
  return problems;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('вкладки на контроллерах', () => {
  it('деньги сходятся, брошенное доиграно, замок свободен, баланс у всех — кошелька', async () => {
    const seen: Seen = { closedRounds: 0, steals: 0, restores: 0, errors: 0, waits: 0 };
    await fc.assert(
      fc.asyncProperty(fc.array(ACTION, { minLength: 1, maxLength: 50 }), async (actions) => {
        expect(await run(actions, seen)).toStrictEqual([]);
      }),
      { numRuns: 1000 },
    );
    // Положительный контроль: прогоны дошли до раундов, ожидания, перехвата, доигрывания и экрана ошибки.
    expect(seen.closedRounds).toBeGreaterThan(0);
    expect(seen.waits).toBeGreaterThan(0);
    expect(seen.steals).toBeGreaterThan(0);
    expect(seen.restores).toBeGreaterThan(0);
    expect(seen.errors).toBeGreaterThan(0);
  });
});
