import fc from 'fast-check';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import {
  parseResponse,
  type AuthenticateResult,
  type BalanceResult,
  type PlayResult,
  type ProtocolError,
  type RequestBody,
  type ResponseEnvelope,
  type WalletChanged,
} from '../../src/protocol/index.ts';
import {
  MemoryLock,
  MemoryStorage,
  RgsServer,
  type Broadcast,
  type CommitBatch,
  type CommitOutcome,
  type Entropy,
  type Lock,
  type Storage,
  type StorageSnapshot,
} from '../../src/server/index.ts';
import { fixtureRound, type FixtureName } from './fixture-rounds.ts';
import { FixedClock, T0 } from './rgs-rig.ts';

// Property сверки кошелька (§14). Две вкладки — два RgsServer на общем хранилище и общем замке. Транспорт теряет
// запрос, теряет ответ, дублирует запрос; fc.scheduler перемежает доставку, ответы, таймауты и каждое обращение
// к хранилищу. Вкладки крутят, бросают раунды, перехватывают чужие по ROUND_ACTIVE, восстанавливаются через
// authenticate и сбрасывают баланс; таймаут и INTERNAL — повтор с тем же телом, как «Повторити».
// После каждой записи и в конце:
// - баланс = 1000 − Σ ставок + Σ выигрышей закрытых раундов с seq ≥ resetSeq, до минимальной единицы; итог раунда —
//   из фикстуры его сида, выигрыш — своей формулой, не winMinor;
// - ключ → не больше одного раунда; активный — не больше одного, и на него указывает кошелёк;
// - подтверждённые ответы совпадают с записями; ROUND_ACTIVE не отвечает на повтор собственного раунда;
// - оповещения — по одному на запись, ревизии подряд; починки без порчи нет.
// Вариант «замок подвёл»: замок без исключения — деньги держит CAS внутри транзакции.

const START = 100_000;
const ATTEMPTS = 5;

/** Сиды фикстур и их итоги: сид → записанный раунд. */
const SEEDED: ReadonlyMap<number, FixtureName> = new Map([
  [1, 'loss'],
  [0, 'small-win'],
  [2, 'base-win'],
  [512, 'cascade-3'],
  [48, 'feature-start'],
]);
const RECORDED = new Map([...SEEDED].map(([seed, name]) => [seed, fixtureRound(name)] as const));

/** Своя формула выигрыша — BigInt, мимо winMinor: floor(ставка × payX100 / 100). */
const ownWin = (betMinor: number, payX100: number): number => Number((BigInt(betMinor) * BigInt(payX100)) / 100n);

type Intent =
  | { readonly kind: 'spin'; readonly bet: number }
  | { readonly kind: 'abandon'; readonly bet: number }
  /** Крупная ставка подряд, пока не кончатся деньги, — путь INSUFFICIENT_FUNDS. */
  | { readonly kind: 'drain' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'restore' };
type Fault = 'deliver' | 'loseRequest' | 'loseResponse' | 'duplicate';

interface TabPlan {
  readonly intents: readonly Intent[];
  readonly faults: readonly Fault[];
  readonly seeds: readonly number[];
}

const BET = fc.constantFrom(20, 100, 1000, 10_000);
const INTENT: fc.Arbitrary<Intent> = fc.oneof(
  { weight: 8, arbitrary: BET.map((bet): Intent => ({ kind: 'spin', bet })) },
  { weight: 1, arbitrary: BET.map((bet): Intent => ({ kind: 'abandon', bet })) },
  { weight: 1, arbitrary: fc.constant<Intent>({ kind: 'drain' }) },
  { weight: 1, arbitrary: fc.constant<Intent>({ kind: 'reset' }) },
  { weight: 1, arbitrary: fc.constant<Intent>({ kind: 'restore' }) },
);
const FAULT: fc.Arbitrary<Fault> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<Fault>('deliver') },
  { weight: 1, arbitrary: fc.constant<Fault>('loseRequest') },
  { weight: 1, arbitrary: fc.constant<Fault>('loseResponse') },
  { weight: 1, arbitrary: fc.constant<Fault>('duplicate') },
);
const TAB: fc.Arbitrary<TabPlan> = fc.record({
  intents: fc.array(INTENT, { minLength: 1, maxLength: 20 }),
  faults: fc.array(FAULT, { maxLength: 40 }),
  // Проигрыш чаще, как в игре; фича (сид 48, 33.50×) редко — иначе баланс не кончается.
  seeds: fc.array(fc.constantFrom(1, 1, 1, 1, 1, 1, 0, 2, 512, 48), { minLength: 1, maxLength: 12 }),
});

interface WalletLike {
  readonly balanceMinor: number;
  readonly activeRoundId: string | null;
  readonly nextSeq: number;
  readonly revision: number;
  readonly resetSeq: number;
}

interface RoundLike {
  readonly roundId: string;
  readonly seq: number;
  readonly idempotencyKey: string;
  readonly betMinor: number;
  readonly seed: number;
  readonly payX100: number;
  readonly winMinor: number;
  readonly events: unknown;
  readonly status: string;
  readonly balanceAfterBet: number;
  readonly balanceAfterEnd: number | null;
}

interface KeyLike {
  readonly roundId: string;
  readonly betMinor: number;
}

/** Сверка одного состояния хранилища: деньги, ключи, активный раунд, seq. Сиды раундов — из фикстур: 1, 0, 2, 512, 48. */
export function audit(snapshot: StorageSnapshot): string[] {
  const wallet = snapshot.wallet[0]?.[1] as WalletLike | undefined;
  if (wallet === undefined) return snapshot.rounds.length > 0 ? ['раунды есть, кошелька нет'] : [];
  const problems: string[] = [];
  const rounds = snapshot.rounds.map(([, value]) => value as RoundLike);
  let expected = START;
  for (const round of rounds) {
    const recorded = RECORDED.get(round.seed);
    if (recorded?.payX100 !== round.payX100) problems.push(`${round.roundId}: итог ${String(round.payX100)} не по сиду ${String(round.seed)}`);
    const win = ownWin(round.betMinor, recorded?.payX100 ?? 0);
    if (round.winMinor !== win) problems.push(`${round.roundId}: выигрыш ${String(round.winMinor)}, по формуле ${String(win)}`);
    if (round.status === 'closed' && round.balanceAfterEnd !== round.balanceAfterBet + win) {
      problems.push(`${round.roundId}: balanceAfterEnd не равен balanceAfterBet + выигрыш`);
    }
    if (round.seq >= wallet.resetSeq) expected += round.status === 'closed' ? win - round.betMinor : -round.betMinor;
    if (round.seq >= wallet.nextSeq) problems.push(`${round.roundId}: seq ${String(round.seq)} не позади nextSeq`);
  }
  if (wallet.balanceMinor !== expected) problems.push(`баланс ${String(wallet.balanceMinor)}, по раундам ${String(expected)}`);
  if (wallet.resetSeq > wallet.nextSeq) problems.push('resetSeq впереди nextSeq');

  const active = rounds.filter((round) => round.status === 'active');
  const pointed = wallet.activeRoundId === null ? [] : [wallet.activeRoundId];
  if (JSON.stringify(active.map((round) => round.roundId)) !== JSON.stringify(pointed)) {
    problems.push(`активные ${JSON.stringify(active.map((round) => round.roundId))}, кошелёк — ${String(wallet.activeRoundId)}`);
  }
  for (const round of active) {
    if (round.balanceAfterBet !== wallet.balanceMinor) problems.push(`${round.roundId}: активный не сходится с балансом`);
  }

  const owners = new Map<string, string[]>();
  for (const round of rounds) owners.set(round.idempotencyKey, [...(owners.get(round.idempotencyKey) ?? []), round.roundId]);
  for (const [key, ids] of owners) if (ids.length > 1) problems.push(`ключ ${key} → ${ids.join(', ')}`);
  const keys = new Map(snapshot.keys.map(([key, value]) => [key, value as KeyLike] as const));
  for (const round of rounds) {
    const record = keys.get(round.idempotencyKey);
    if (record?.roundId !== round.roundId || record.betMinor !== round.betMinor) problems.push(`${round.roundId}: запись ключа не та`);
  }
  if (keys.size !== rounds.length) problems.push(`ключей ${String(keys.size)} на ${String(rounds.length)} раундов`);
  if (new Set(rounds.map((round) => round.seq)).size !== rounds.length) problems.push('seq повторяется');
  if (snapshot.quarantine.length > 0) problems.push('карантин не пуст: починка без порчи');
  return problems;
}

/** Каждое обращение к хранилищу — точка планировщика; после каждой записи — сверка состояния. */
class ScheduledStorage implements Storage {
  readonly durable = true;
  readonly #inner: MemoryStorage;
  readonly #s: fc.Scheduler;
  readonly #world: World;

  constructor(inner: MemoryStorage, s: fc.Scheduler, world: World) {
    this.#inner = inner;
    this.#s = s;
    this.#world = world;
  }

  get(...args: Parameters<Storage['get']>): ReturnType<Storage['get']> {
    return this.#step(`get ${args[0]}`, () => this.#inner.get(...args));
  }

  keysByIndex(...args: Parameters<Storage['keysByIndex']>): ReturnType<Storage['keysByIndex']> {
    return this.#step(`keysByIndex ${args[0]}`, () => this.#inner.keysByIndex(...args));
  }

  lastByIndex(...args: Parameters<Storage['lastByIndex']>): ReturnType<Storage['lastByIndex']> {
    return this.#step(`lastByIndex ${args[0]}`, () => this.#inner.lastByIndex(...args));
  }

  descend(...args: Parameters<Storage['descend']>): ReturnType<Storage['descend']> {
    return this.#step(`descend ${args[0]}`, () => this.#inner.descend(...args));
  }

  commit(batch: CommitBatch): Promise<CommitOutcome> {
    return this.#step('commit', async () => {
      const outcome = await this.#inner.commit(batch);
      this.#world.committed(outcome, this.#inner.snapshot());
      return outcome;
    });
  }

  #step<T>(label: string, work: () => Promise<T>): Promise<T> {
    return this.#s.schedule(Promise.resolve(), label).then(work);
  }
}

/** Сиды вкладки по кругу; id раундов — с буквой вкладки, чтобы не пересекаться. */
class CyclingEntropy implements Entropy {
  readonly #seeds: readonly number[];
  readonly #prefix: string;
  #next = 0;
  #rounds = 0;

  constructor(seeds: readonly number[], prefix: string) {
    this.#seeds = seeds;
    this.#prefix = prefix;
  }

  seed(): number {
    const seed = this.#seeds[this.#next % this.#seeds.length] ?? 1;
    this.#next += 1;
    return seed;
  }

  roundId(): string {
    this.#rounds += 1;
    return `${this.#prefix}${String(this.#rounds)}`;
  }
}

/** Общий мир прогона: хранилище, журнал записей и оповещений, наблюдения вкладок, нарушения. */
class World implements Broadcast {
  readonly inner = new MemoryStorage({ durable: true });
  readonly violations: string[] = [];
  readonly inFlight: Promise<unknown>[] = [];
  readonly broadcasts: WalletChanged[] = [];
  readonly confirmedPlays: { readonly key: string; readonly bet: number; readonly result: PlayResult }[] = [];
  readonly confirmedEnds: { readonly roundId: string; readonly balanceMinor: number }[] = [];
  readonly roundActive: { readonly key: string; readonly roundId: string }[] = [];
  /** Сколько раз сервер ответил ok на play с этим ключом — больше одного значит повтор нашёл свой раунд. */
  readonly playOks = new Map<string, number>();
  readonly stats = { commits: 0, conflicts: 0, internal: 0, timeouts: 0, duplicates: 0, resets: 0, funds: 0, takeovers: 0, restored: 0 };
  #revision = 0;

  committed(outcome: CommitOutcome, snapshot: StorageSnapshot): void {
    if (outcome === 'conflict') {
      this.stats.conflicts += 1;
      return;
    }
    this.stats.commits += 1;
    const revision = (snapshot.wallet[0]?.[1] as WalletLike | undefined)?.revision;
    if (revision !== this.#revision + 1) this.violations.push(`ревизия ${String(revision)} после ${String(this.#revision)}`);
    this.#revision = revision ?? this.#revision;
    this.violations.push(...audit(snapshot).map((problem) => `после записи ${String(this.stats.commits)}: ${problem}`));
  }

  walletChanged(message: WalletChanged): void {
    this.broadcasts.push(message);
  }

  handled(envelope: { readonly body: RequestBody }, response: ResponseEnvelope): void {
    const { body } = envelope;
    if (body.type === 'play' && response.body.ok) this.playOks.set(body.idempotencyKey, (this.playOks.get(body.idempotencyKey) ?? 0) + 1);
  }
}

/** Провод вкладки к её серверу: судьба попытки — по сценарию сбоев, каждое движение — точка планировщика. */
class Wire {
  readonly #s: fc.Scheduler;
  readonly #server: RgsServer;
  readonly #world: World;
  readonly #tab: string;
  #id = 0;

  constructor(s: fc.Scheduler, server: RgsServer, world: World, tab: string) {
    this.#s = s;
    this.#server = server;
    this.#world = world;
    this.#tab = tab;
  }

  async attempt(body: RequestBody, fault: Fault): Promise<ResponseEnvelope | 'timeout'> {
    this.#id += 1;
    const envelope = { v: 1, id: this.#id, body };
    switch (fault) {
      case 'loseRequest':
        return this.#timeout();
      case 'loseResponse':
        // Сервер может получить запрос и до, и после таймаута — повтор идёт наперегонки с оригиналом.
        this.#world.inFlight.push(this.#deliver(envelope));
        return this.#timeout();
      case 'duplicate': {
        this.#world.stats.duplicates += 1;
        const first = this.#deliver(envelope);
        this.#world.inFlight.push(this.#deliver(envelope));
        return this.#back(await first);
      }
      case 'deliver':
        return this.#back(await this.#deliver(envelope));
    }
  }

  async #timeout(): Promise<'timeout'> {
    this.#world.stats.timeouts += 1;
    await this.#s.schedule(Promise.resolve(), `${this.#tab} таймаут`);
    return 'timeout';
  }

  async #deliver(envelope: { readonly v: number; readonly id: number; readonly body: RequestBody }): Promise<ResponseEnvelope> {
    await this.#s.schedule(Promise.resolve(), `${this.#tab} → ${envelope.body.type} #${String(envelope.id)}`);
    const response = await this.#server.handle(structuredClone(envelope));
    this.#world.handled(envelope, response);
    return response;
  }

  async #back(response: ResponseEnvelope): Promise<ResponseEnvelope> {
    await this.#s.schedule(Promise.resolve(), `${this.#tab} ← ответ #${String(response.id)}`);
    return structuredClone(response);
  }
}

type Answer = { readonly kind: 'result'; readonly result: unknown } | { readonly kind: 'error'; readonly error: ProtocolError };

/** Вкладка: намерения по очереди; каждый вызов — до ATTEMPTS попыток с тем же телом. */
class Tab {
  readonly #name: string;
  readonly #wire: Wire;
  readonly #world: World;
  readonly #faults: Fault[];
  #keys = 0;

  constructor(name: string, wire: Wire, world: World, faults: readonly Fault[]) {
    this.#name = name;
    this.#wire = wire;
    this.#world = world;
    this.#faults = [...faults];
  }

  async run(intents: readonly Intent[]): Promise<void> {
    for (const intent of intents) {
      switch (intent.kind) {
        case 'spin':
          await this.#spin(intent.bet, true);
          break;
        case 'abandon':
          await this.#spin(intent.bet, false);
          break;
        case 'drain':
          for (let spin = 0; spin < 12 && (await this.#spin(10_000, true)) === 'played'; spin++);
          break;
        case 'reset': {
          const answer = await this.#call({ type: 'resetBalance' });
          if (answer?.kind === 'result') this.#world.stats.resets += 1;
          else if (answer?.kind === 'error' && answer.error.code !== 'ROUND_ACTIVE') this.#violation(`resetBalance → ${answer.error.code}`);
          break;
        }
        case 'restore': {
          const answer = await this.#call({ type: 'authenticate' });
          if (answer?.kind === 'error') this.#violation(`authenticate → ${answer.error.code}`);
          if (answer?.kind !== 'result') break;
          const auth = answer.result as AuthenticateResult;
          if (auth.notice !== null) this.#violation(`authenticate: уведомление ${auth.notice}`);
          if (auth.activeRound !== null) {
            this.#world.stats.restored += 1;
            await this.#end(auth.activeRound.roundId);
          }
          break;
        }
      }
    }
  }

  async #spin(bet: number, finish: boolean): Promise<'played' | 'stopped'> {
    this.#keys += 1;
    const key = `${this.#name}-k${String(this.#keys)}`;
    const answer = await this.#call({ type: 'play', betMinor: bet, idempotencyKey: key });
    // Все попытки потеряны — раунд, может быть, записан и остался активным: брошенный.
    if (answer === null) return 'stopped';
    if (answer.kind === 'result') {
      const result = answer.result as PlayResult;
      this.#world.confirmedPlays.push({ key, bet, result });
      if (finish) await this.#end(result.round.roundId);
      return 'played';
    }
    const { error } = answer;
    if (error.code === 'ROUND_ACTIVE') {
      // Перехват: активный раунд чужой или брошенный — доиграть его.
      this.#world.roundActive.push({ key, roundId: error.roundId });
      this.#world.stats.takeovers += 1;
      await this.#end(error.roundId);
    } else if (error.code === 'INSUFFICIENT_FUNDS') {
      this.#world.stats.funds += 1;
    } else {
      this.#violation(`play → ${error.code}`);
    }
    return 'stopped';
  }

  async #end(roundId: string): Promise<void> {
    const answer = await this.#call({ type: 'endRound', roundId });
    if (answer?.kind === 'result') {
      this.#world.confirmedEnds.push({ roundId, balanceMinor: (answer.result as BalanceResult).balanceMinor });
    } else if (answer?.kind === 'error') {
      this.#violation(`endRound ${roundId} → ${answer.error.code}`);
    }
  }

  /** Таймаут и INTERNAL — повтор с тем же телом; ответ проверяет гард клиента. null — попытки кончились. */
  async #call(body: RequestBody): Promise<Answer | null> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const raw = await this.#wire.attempt(body, this.#faults.shift() ?? 'deliver');
      if (raw === 'timeout') continue;
      const parsed = parseResponse(body.type, raw);
      if (parsed.kind === 'invalid' || parsed.kind === 'version') {
        this.#violation(`${body.type}: ответ не прошёл гард клиента — ${parsed.kind === 'invalid' ? parsed.problem : 'версия'}`);
        return null;
      }
      if (parsed.kind === 'error' && parsed.error.code === 'INTERNAL') {
        this.#world.stats.internal += 1;
        continue;
      }
      return parsed.kind === 'result' ? { kind: 'result', result: parsed.result } : { kind: 'error', error: parsed.error };
    }
    return null;
  }

  #violation(problem: string): void {
    this.#world.violations.push(`${this.#name}: ${problem}`);
  }
}

/** Итоговые сверки: подтверждённые ответы против записей, ROUND_ACTIVE, оповещения. */
function finalChecks(world: World, lockHolds: boolean): string[] {
  const snapshot = world.inner.snapshot();
  const problems = audit(snapshot);
  const rounds = new Map(snapshot.rounds.map(([id, value]) => [id, value as RoundLike] as const));
  for (const { key, bet, result } of world.confirmedPlays) {
    const round = rounds.get(result.round.roundId);
    const recorded = round === undefined ? undefined : RECORDED.get(round.seed);
    const same =
      round?.idempotencyKey === key &&
      round.betMinor === bet &&
      result.round.betMinor === bet &&
      round.balanceAfterBet === result.balanceMinor &&
      round.payX100 === result.round.payX100 &&
      round.winMinor === result.round.winMinor &&
      JSON.stringify(result.round.events) === JSON.stringify(recorded?.events);
    if (!same) problems.push(`подтверждённый play ${key} → ${result.round.roundId} не совпадает с записью`);
  }
  for (const { roundId, balanceMinor } of world.confirmedEnds) {
    const round = rounds.get(roundId);
    if (round?.status !== 'closed' || round.balanceAfterEnd !== balanceMinor) problems.push(`подтверждённый endRound ${roundId} не совпадает с записью`);
  }
  for (const { key, roundId } of world.roundActive) {
    if (rounds.get(roundId)?.idempotencyKey === key) problems.push(`ROUND_ACTIVE на повтор своего раунда ${roundId} (ключ ${key})`);
  }
  if (world.broadcasts.length !== world.stats.commits) {
    problems.push(`оповещений ${String(world.broadcasts.length)} на ${String(world.stats.commits)} записей`);
  }
  world.broadcasts.forEach((message, index) => {
    if (message.revision !== index + 1 || message.notice !== null) problems.push(`оповещение ${String(index + 1)}: ревизия ${String(message.revision)}, notice ${String(message.notice)}`);
  });
  if (lockHolds && world.stats.conflicts + world.stats.internal > 0) {
    problems.push(`под замком конфликтов ${String(world.stats.conflicts)}, INTERNAL ${String(world.stats.internal)}`);
  }
  return problems;
}

/** Замок, который не исключает: обе вкладки пишут одновременно. */
const BROKEN_LOCK: Lock = { withLock: (_name, task) => task() };

export interface Totals {
  replays: number;
  takeovers: number;
  restored: number;
  resets: number;
  funds: number;
  timeouts: number;
  duplicates: number;
  conflicts: number;
  internal: number;
  commits: number;
}

/** Прогон двух вкладок; totals копит покрытие по всем прогонам. */
export function walletProperty(lockHolds: boolean, totals: Totals): fc.IAsyncPropertyWithHooks<[fc.Scheduler, TabPlan, TabPlan]> {
  return fc.asyncProperty(fc.scheduler(), TAB, TAB, async (s, planA, planB) => {
    const world = new World();
    const storage = new ScheduledStorage(world.inner, s, world);
    const lock: Lock = lockHolds ? new MemoryLock() : BROKEN_LOCK;
    const tab = (name: string, plan: TabPlan): Tab => {
      const server = new RgsServer(
        { storage, lock, clock: new FixedClock(T0), entropy: new CyclingEntropy(plan.seeds, name), broadcast: world },
        { config: DEFAULT_CONFIG },
      );
      return new Tab(name, new Wire(s, server, world, name), world, plan.faults);
    };
    const done = Promise.all([tab('a', planA).run(planA.intents), tab('b', planB).run(planB.intents)]);
    await s.waitFor(done);
    // Поздние дубли и потерянные ответы: сервер доделывает всё, что до него дошло.
    await s.waitFor(Promise.all(world.inFlight));
    await s.waitIdle();

    const problems = [...world.violations, ...finalChecks(world, lockHolds)];
    totals.replays += [...world.playOks.values()].filter((count) => count > 1).length;
    for (const name of ['takeovers', 'restored', 'resets', 'funds', 'timeouts', 'duplicates', 'conflicts', 'internal', 'commits'] as const) {
      totals[name] += world.stats[name];
    }
    if (problems.length > 0) throw new Error(problems.slice(0, 10).join('\n'));
  });
}

export const zeroTotals = (): Totals => ({
  replays: 0,
  takeovers: 0,
  restored: 0,
  resets: 0,
  funds: 0,
  timeouts: 0,
  duplicates: 0,
  conflicts: 0,
  internal: 0,
  commits: 0,
});
