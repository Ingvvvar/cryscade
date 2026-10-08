import { CASCADE_SLOTS, type StatsRecorder } from '../../src/core/engine/index.ts';
import { PAYING_SYMBOL_COUNT } from '../../src/core/model/symbols.ts';

// Сборщик статистики симулятора. Копит только целые — гистограммы, счётчики, суммы — и сливается точным
// сложением: итог не зависит от того, какой поток какую задачу посчитал. Дробные числа — только в отчёте.

/**
 * Наибольший множитель кластера за раунд: ячейка 0 — кластеров не было, ячейка k ≥ 1 — от 2^(k−1) до 2^k − 1.
 * 49 × 128 = 6272 < 2^13, поэтому ячеек 14.
 */
export const MULT_SLOTS = 14;
export const LEVEL_SLOTS = 9;
export const AWARD_SLOTS = 64;
/** Наибольший кап для гистограмм: 10 000× ставки, три гистограммы по 8 МБ на поток. */
export const MAX_CAP_X100 = 1_000_000;

interface Extreme {
  /** Выплата или число запросов; при равенстве побеждает меньший сид. */
  readonly value: number;
  readonly seed: number;
}

/** Итоги одной задачи — для стандартных ошибок по пакетам. */
export interface Batch {
  readonly index: number;
  readonly rounds: number;
  readonly payX100: number;
  readonly baseX100: number;
  readonly featureX100: number;
  readonly wins: number;
  readonly overBet: number;
  readonly features: number;
}

/** Простые данные: переживают postMessage. */
export interface MathPlain {
  readonly capX100: number;
  readonly bands: number;
  readonly rounds: number;
  /** Число раундов по итоговой выплате, индекс — payX100 от 0 до капа. */
  readonly total: Float64Array;
  /** По выплате основной игры — все раунды. */
  readonly base: Float64Array;
  /** По выплате фичи — только раунды с фичей. */
  readonly feature: Float64Array;
  readonly awards: Float64Array;
  readonly freeSpins: number;
  readonly retriggers: number;
  /** Спины по длине каскада: фаза × 64 + длина. */
  readonly cascades: Float64Array;
  readonly maxMult: Float64Array;
  readonly maxLevel: Float64Array;
  /** Использование таблицы и число кластеров: (фаза × 7 + символ) × bands + полоса. */
  readonly usage: Float64Array;
  readonly clusters: Float64Array;
  /** Использование таблицы в раундах, упёршихся в кап, — для поправки линейной модели на кап. */
  readonly usageCapped: Float64Array;
  readonly requests: number;
  readonly longest: Extreme;
  readonly top: Extreme;
  readonly batches: readonly Batch[];
}

function better(a: Extreme, b: Extreme): Extreme {
  if (b.value !== a.value) return b.value > a.value ? b : a;
  return b.seed < a.seed ? b : a;
}

function assertSafe(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what}: ${String(value)} вне точных целых (2^53)`);
  return value;
}

function addInto(target: Float64Array, source: Float64Array, what: string): void {
  if (target.length !== source.length) throw new RangeError(`${what}: длины ${String(target.length)} и ${String(source.length)}`);
  for (let index = 0; index < target.length; index++) {
    target[index] = assertSafe((target[index] ?? 0) + (source[index] ?? 0), what);
  }
}

export class MathStats {
  readonly #capX100: number;
  readonly #bands: number;
  readonly #total: Float64Array;
  readonly #base: Float64Array;
  readonly #feature: Float64Array;
  readonly #awards = new Float64Array(AWARD_SLOTS);
  readonly #cascades = new Float64Array(2 * CASCADE_SLOTS);
  readonly #maxMult = new Float64Array(MULT_SLOTS);
  readonly #maxLevel = new Float64Array(LEVEL_SLOTS);
  readonly #usage: Float64Array;
  readonly #clusters: Float64Array;
  readonly #usageCapped: Float64Array;
  readonly #scratchUsage: Float64Array;
  readonly #scratchClusters: Float64Array;
  readonly #batches: Batch[] = [];
  #rounds = 0;
  #freeSpins = 0;
  #retriggers = 0;
  #requests = 0;
  #longest: Extreme = { value: -1, seed: 0 };
  #top: Extreme = { value: -1, seed: 0 };
  #batch: { index: number; rounds: number; payX100: number; baseX100: number; featureX100: number; wins: number; overBet: number; features: number } | null = null;

  constructor(capX100: number, bands: number) {
    // Гистограммы — по каждой выплате до капа: три массива по 8 байт на значение.
    if (!Number.isSafeInteger(capX100) || capX100 < 1 || capX100 > MAX_CAP_X100) {
      throw new RangeError(`кап ${String(capX100)}: гистограммы симулятора — до ${String(MAX_CAP_X100)}`);
    }
    this.#capX100 = capX100;
    this.#bands = bands;
    this.#total = new Float64Array(capX100 + 1);
    this.#base = new Float64Array(capX100 + 1);
    this.#feature = new Float64Array(capX100 + 1);
    const cells = 2 * PAYING_SYMBOL_COUNT * bands;
    this.#usage = new Float64Array(cells);
    this.#clusters = new Float64Array(cells);
    this.#usageCapped = new Float64Array(cells);
    this.#scratchUsage = new Float64Array(cells);
    this.#scratchClusters = new Float64Array(cells);
  }

  /** Начало задачи: её раунды пойдут в отдельный пакет. */
  startTask(index: number): void {
    this.#closeBatch();
    this.#batch = { index, rounds: 0, payX100: 0, baseX100: 0, featureX100: 0, wins: 0, overBet: 0, features: 0 };
  }

  add(seed: number, stats: StatsRecorder, requests: number): void {
    const pay = stats.payX100;
    this.#rounds += 1;
    this.#total[pay] = (this.#total[pay] ?? 0) + 1;
    this.#base[stats.basePayX100] = (this.#base[stats.basePayX100] ?? 0) + 1;
    if (stats.featured) {
      this.#feature[stats.featurePayX100] = (this.#feature[stats.featurePayX100] ?? 0) + 1;
      const award = Math.min(stats.awardedSpins, AWARD_SLOTS - 1);
      this.#awards[award] = (this.#awards[award] ?? 0) + 1;
      this.#freeSpins += stats.freeSpins;
      this.#retriggers += stats.retriggers;
    }
    const multSlot = stats.maxClusterMult === 0 ? 0 : 32 - Math.clz32(stats.maxClusterMult);
    this.#maxMult[multSlot] = (this.#maxMult[multSlot] ?? 0) + 1;
    this.#maxLevel[stats.maxLevel] = (this.#maxLevel[stats.maxLevel] ?? 0) + 1;
    stats.addCascadesTo(this.#cascades);
    if (stats.capped) {
      this.#scratchUsage.fill(0);
      this.#scratchClusters.fill(0);
      stats.addUsageTo(this.#scratchUsage, this.#scratchClusters);
      for (let index = 0; index < this.#usage.length; index++) {
        const used = this.#scratchUsage[index] ?? 0;
        this.#usage[index] = (this.#usage[index] ?? 0) + used;
        this.#usageCapped[index] = (this.#usageCapped[index] ?? 0) + used;
        this.#clusters[index] = (this.#clusters[index] ?? 0) + (this.#scratchClusters[index] ?? 0);
      }
    } else {
      stats.addUsageTo(this.#usage, this.#clusters);
    }
    this.#requests += requests;
    if (requests > this.#longest.value || (requests === this.#longest.value && seed < this.#longest.seed)) {
      this.#longest = { value: requests, seed };
    }
    if (pay > this.#top.value || (pay === this.#top.value && seed < this.#top.seed)) this.#top = { value: pay, seed };

    const batch = this.#batch;
    if (batch !== null) {
      batch.rounds += 1;
      batch.payX100 += pay;
      batch.baseX100 += stats.basePayX100;
      batch.featureX100 += stats.featurePayX100;
      if (pay > 0) batch.wins += 1;
      if (pay > 100) batch.overBet += 1;
      if (stats.featured) batch.features += 1;
    }
  }

  toPlain(): MathPlain {
    this.#closeBatch();
    return {
      capX100: this.#capX100,
      bands: this.#bands,
      rounds: this.#rounds,
      total: this.#total,
      base: this.#base,
      feature: this.#feature,
      awards: this.#awards,
      freeSpins: this.#freeSpins,
      retriggers: this.#retriggers,
      cascades: this.#cascades,
      maxMult: this.#maxMult,
      maxLevel: this.#maxLevel,
      usage: this.#usage,
      clusters: this.#clusters,
      usageCapped: this.#usageCapped,
      requests: this.#requests,
      longest: this.#longest,
      top: this.#top,
      batches: [...this.#batches].sort((a, b) => a.index - b.index),
    };
  }

  /** Точное слияние: сложение целых с проверкой 2^53, экстремумы — по выплате, при равенстве по меньшему сиду. */
  merge(plain: MathPlain): void {
    if (plain.capX100 !== this.#capX100 || plain.bands !== this.#bands) throw new RangeError('слияние статистики разных конфигов');
    this.#closeBatch();
    this.#rounds = assertSafe(this.#rounds + plain.rounds, 'раунды');
    addInto(this.#total, plain.total, 'итоги');
    addInto(this.#base, plain.base, 'основная игра');
    addInto(this.#feature, plain.feature, 'фича');
    addInto(this.#awards, plain.awards, 'награды');
    this.#freeSpins = assertSafe(this.#freeSpins + plain.freeSpins, 'фриспины');
    this.#retriggers = assertSafe(this.#retriggers + plain.retriggers, 'ретриггеры');
    addInto(this.#cascades, plain.cascades, 'каскады');
    addInto(this.#maxMult, plain.maxMult, 'множители');
    addInto(this.#maxLevel, plain.maxLevel, 'уровни');
    addInto(this.#usage, plain.usage, 'использование таблицы');
    addInto(this.#clusters, plain.clusters, 'кластеры');
    addInto(this.#usageCapped, plain.usageCapped, 'использование при капе');
    this.#requests = assertSafe(this.#requests + plain.requests, 'запросы');
    this.#longest = better(this.#longest, plain.longest);
    this.#top = better(this.#top, plain.top);
    this.#batches.push(...plain.batches);
  }

  #closeBatch(): void {
    if (this.#batch !== null && this.#batch.rounds > 0) this.#batches.push({ ...this.#batch });
    this.#batch = null;
  }
}
