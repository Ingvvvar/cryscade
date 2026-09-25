import type { GameConfig } from '../model/config.ts';
import { CELL_COUNT } from '../model/grid.ts';
import { PAYING_SYMBOL_COUNT } from '../model/symbols.ts';
import type { RoundRecorder } from './recorder.ts';
import type { ClusterView, SpotsView } from './views.ts';

/** Фаза раунда в индексах: 0 — основная игра, 1 — фича. */
const PHASES = 2;
/** Длины каскада от 0 до 63; длиннее — в последнюю ячейку. */
export const CASCADE_SLOTS = 64;

/**
 * Статистика раунда для симулятора и книги (Strategy рекордера, третий режим). Без аллокаций, как движок:
 * буферы создаются в конструкторе, на begin обнуляются.
 *
 * Использование таблицы — сумма множителей по клеткам (фаза × символ × полоса). Выплата кластера — таблица × mult,
 * поэтому выплата раунда без капа линейна по таблице: Σ таблица[клетка] × использование[клетка].
 */
export class StatsRecorder implements RoundRecorder {
  readonly #bands: number;
  readonly #bandOf = new Uint8Array(CELL_COUNT + 1);
  readonly #usage: Float64Array;
  readonly #clusters: Float64Array;
  readonly #cascades = new Float64Array(PHASES * CASCADE_SLOTS);
  #phase = 0;
  #spinOpen = false;
  #spinPhase = 0;
  #spinSteps = 0;
  #baseX100 = 0;
  #featureX100 = 0;
  #payX100 = 0;
  #featured = false;
  #awarded = 0;
  #freeSpins = 0;
  #retriggers = 0;
  #capped = false;
  #cappedInFeature = false;
  #steps = 0;
  #longest = 0;
  #maxMult = 0;
  #maxLevel = 0;

  constructor(config: Pick<GameConfig, 'sizeBands'>) {
    const bands = config.sizeBands;
    if (bands.length === 0) throw new RangeError('sizeBands: пустой список полос');
    this.#bands = bands.length;
    let band = 0;
    for (let size = 0; size <= CELL_COUNT; size++) {
      while (band + 1 < bands.length && size >= (bands[band + 1] ?? CELL_COUNT + 1)) band += 1;
      this.#bandOf[size] = band;
    }
    this.#usage = new Float64Array(PHASES * PAYING_SYMBOL_COUNT * this.#bands);
    this.#clusters = new Float64Array(PHASES * PAYING_SYMBOL_COUNT * this.#bands);
  }

  /** Полос в таблице: размер одной фазы в буферах использования — 7 × bands. */
  get bands(): number {
    return this.#bands;
  }

  get payX100(): number {
    return this.#payX100;
  }

  /** Выплата основной игры; кап в основной игре обрезает её до капа. */
  get basePayX100(): number {
    return this.#baseX100;
  }

  /** Выплата фичи; кап в фиче обрезает её до «кап − основная игра». */
  get featurePayX100(): number {
    return this.#featureX100;
  }

  get featured(): boolean {
    return this.#featured;
  }

  /** Фриспинов в награде за ядра основного спина, без ретриггеров. */
  get awardedSpins(): number {
    return this.#awarded;
  }

  get freeSpins(): number {
    return this.#freeSpins;
  }

  get retriggers(): number {
    return this.#retriggers;
  }

  get capped(): boolean {
    return this.#capped;
  }

  /** Выигрышных шагов за раунд, во всех спинах. */
  get cascadeSteps(): number {
    return this.#steps;
  }

  /** Самая длинная цепочка выигрышных шагов в одном спине. */
  get longestCascade(): number {
    return this.#longest;
  }

  get maxClusterMult(): number {
    return this.#maxMult;
  }

  get maxLevel(): number {
    return this.#maxLevel;
  }

  /** Прибавляет использование таблицы и число кластеров раунда: индекс (фаза × 7 + символ) × bands + полоса. */
  addUsageTo(usage: Float64Array, clusters: Float64Array): void {
    for (let index = 0; index < this.#usage.length; index++) {
      usage[index] = (usage[index] ?? 0) + (this.#usage[index] ?? 0);
      clusters[index] = (clusters[index] ?? 0) + (this.#clusters[index] ?? 0);
    }
  }

  /** Прибавляет спины раунда по длине каскада: индекс фаза × 64 + длина. */
  addCascadesTo(target: Float64Array): void {
    for (let index = 0; index < this.#cascades.length; index++) {
      target[index] = (target[index] ?? 0) + (this.#cascades[index] ?? 0);
    }
  }

  begin(): void {
    this.#phase = 0;
    this.#spinOpen = false;
    this.#spinPhase = 0;
    this.#spinSteps = 0;
    this.#baseX100 = 0;
    this.#featureX100 = 0;
    this.#payX100 = 0;
    this.#featured = false;
    this.#awarded = 0;
    this.#freeSpins = 0;
    this.#retriggers = 0;
    this.#capped = false;
    this.#cappedInFeature = false;
    this.#steps = 0;
    this.#longest = 0;
    this.#maxMult = 0;
    this.#maxLevel = 0;
    this.#usage.fill(0);
    this.#clusters.fill(0);
    this.#cascades.fill(0);
  }

  fill(): void {
    this.#closeSpin();
    this.#spinOpen = true;
    this.#spinPhase = this.#phase;
    this.#spinSteps = 0;
  }

  win(clusters: ClusterView): void {
    this.#spinSteps += 1;
    this.#steps += 1;
    this.#longest = Math.max(this.#longest, this.#spinSteps);
    const offset = this.#phase * PAYING_SYMBOL_COUNT;
    for (let cluster = 0; cluster < clusters.count; cluster++) {
      const mult = clusters.mult(cluster);
      const index = (offset + clusters.symbol(cluster)) * this.#bands + (this.#bandOf[clusters.size(cluster)] ?? 0);
      this.#usage[index] = (this.#usage[index] ?? 0) + mult;
      this.#clusters[index] = (this.#clusters[index] ?? 0) + 1;
      this.#maxMult = Math.max(this.#maxMult, mult);
      if (this.#phase === 0) this.#baseX100 += clusters.payX100(cluster);
      else this.#featureX100 += clusters.payX100(cluster);
    }
  }

  explode(): void {}

  spots(spots: SpotsView): void {
    for (let index = 0; index < spots.count; index++) this.#maxLevel = Math.max(this.#maxLevel, spots.levelAt(index));
  }

  refill(): void {}
  scatters(): void {}

  fsStart(spins: number): void {
    this.#featured = true;
    this.#awarded = spins;
    this.#phase = 1;
  }

  fsSpin(): void {
    this.#freeSpins += 1;
  }

  fsRetrigger(): void {
    this.#retriggers += 1;
  }

  cap(): void {
    this.#capped = true;
    this.#cappedInFeature = this.#phase === 1;
  }

  end(payX100: number): void {
    this.#closeSpin();
    this.#payX100 = payX100;
    // Обрезку капом относим к фазе, где кап наступил: до неё сумма другой фазы меньше капа.
    if (this.#capped && !this.#cappedInFeature) {
      this.#baseX100 = payX100;
      this.#featureX100 = 0;
    } else if (this.#capped) {
      this.#featureX100 = payX100 - this.#baseX100;
    }
  }

  #closeSpin(): void {
    if (!this.#spinOpen) return;
    const slot = Math.min(this.#spinSteps, CASCADE_SLOTS - 1);
    const index = this.#spinPhase * CASCADE_SLOTS + slot;
    this.#cascades[index] = (this.#cascades[index] ?? 0) + 1;
    this.#spinOpen = false;
  }
}
