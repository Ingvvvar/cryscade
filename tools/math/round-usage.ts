import type { ClusterView, RoundRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';
import { CELL_COUNT } from '../../src/core/model/grid.ts';
import { PAYING_SYMBOL_COUNT } from '../../src/core/model/symbols.ts';

// Использование таблицы по раундам — для подбора таблицы при неизменных весах (вариант 4). У каждого выигрышного
// раунда — разреженный вектор «клетка таблицы (фаза × символ × полоса) → сумма множителей её кластеров». Выплата
// кластера — таблица × mult, поэтому выплата раунда без капа линейна по таблице (как у StatsRecorder), а с капом —
// min(кап, Σ таблица × использование): раунд, дошедший до капа, платит ровно кап, где бы движок его ни оборвал. Для
// этого раунд пишется целиком — кап движка при записи недостижимый (UNCAPPED). Одинаковые векторы — одна запись со
// счётом: раунды основной игры с одним кластером повторяются миллионами, раунды с фичей почти все разные.

/** Кап записи: ни один раунд до него не дойдёт — вектор раунда полный, кап таблицы применяет оценка. */
export const UNCAPPED_X100 = Number.MAX_SAFE_INTEGER;

/** Клеток таблицы на фазу: 7 символов × полосы. Фаза 0 — основная игра, 1 — фича. */
function phaseCells(bands: number): number {
  return PAYING_SYMBOL_COUNT * bands;
}

/** Приставка ключа раунда с фичей: фича — событие раунда, а не выигрыш, у неё может не быть ни одного кластера. */
const FEATURED = '*';

/**
 * Рекордер записи: копит вектор раунда в буфере на все клетки обеих фаз, на end — отдаёт его строкой-ключом
 * «клетка:сумма,…» по возрастанию клетки, с приставкой FEATURED у раунда с фичей. Проигрыш без фичи — пустая строка.
 */
export class UsageRecorder implements RoundRecorder {
  readonly #bandOf = new Uint8Array(CELL_COUNT + 1);
  readonly #usage: Float64Array;
  /** Клетки, тронутые в этом раунде: проигрыш не обходит весь буфер. */
  readonly #touched: Uint8Array;
  #touchedCount = 0;
  readonly #perPhase: number;
  readonly #bands: number;
  #phase = 0;
  #featured = false;
  #key = '';

  constructor(config: Pick<GameConfig, 'sizeBands'>) {
    const bands = config.sizeBands;
    this.#bands = bands.length;
    let band = 0;
    for (let size = 0; size <= CELL_COUNT; size++) {
      while (band + 1 < bands.length && size >= (bands[band + 1] ?? CELL_COUNT + 1)) band += 1;
      this.#bandOf[size] = band;
    }
    this.#perPhase = phaseCells(this.#bands);
    this.#usage = new Float64Array(2 * this.#perPhase);
    this.#touched = new Uint8Array(2 * this.#perPhase);
  }

  /** Вектор последнего раунда: «клетка:сумма множителей», через запятую; проигрыш — ''. */
  get key(): string {
    return this.#key;
  }

  begin(): void {
    for (let index = 0; index < this.#touchedCount; index++) this.#usage[this.#touched[index] ?? 0] = 0;
    this.#touchedCount = 0;
    this.#phase = 0;
    this.#featured = false;
    this.#key = '';
  }

  fill(): void {}

  win(clusters: ClusterView): void {
    for (let cluster = 0; cluster < clusters.count; cluster++) {
      const cell = this.#phase * this.#perPhase + clusters.symbol(cluster) * this.#bands + (this.#bandOf[clusters.size(cluster)] ?? 0);
      const before = this.#usage[cell] ?? 0;
      if (before === 0) this.#touched[this.#touchedCount++] = cell;
      this.#usage[cell] = before + clusters.mult(cluster);
    }
  }

  explode(): void {}
  spots(): void {}
  refill(): void {}
  scatters(): void {}

  fsStart(): void {
    this.#phase = 1;
    this.#featured = true;
  }

  fsSpin(): void {}
  fsRetrigger(): void {}
  cap(): void {}

  end(): void {
    if (this.#touchedCount === 0 && !this.#featured) return;
    const cells = Array.from(this.#touched.subarray(0, this.#touchedCount)).sort((a, b) => a - b);
    const body = cells.map((cell) => `${String(cell)}:${String(this.#usage[cell] ?? 0)}`).join(',');
    this.#key = this.#featured ? `${FEATURED}${body}` : body;
  }
}

/** Простые данные набора векторов: переживают postMessage. */
export interface UsagePlain {
  readonly bands: number;
  readonly rounds: number;
  /** Ключи векторов и число раундов с каждым. */
  readonly keys: readonly string[];
  readonly counts: readonly number[];
}

/** Набор векторов с числом раундов: слияние — сложение счётов, итог не зависит от порядка раундов и потоков. */
export class UsageSet {
  readonly #bands: number;
  readonly #counts = new Map<string, number>();
  #rounds = 0;

  constructor(bands: number) {
    this.#bands = bands;
  }

  get rounds(): number {
    return this.#rounds;
  }

  add(key: string, count = 1): void {
    this.#rounds += count;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + count);
  }

  merge(plain: UsagePlain): void {
    if (plain.bands !== this.#bands) throw new RangeError(`полос ${String(plain.bands)}, ожидалось ${String(this.#bands)}`);
    plain.keys.forEach((key, index) => {
      this.add(key, plain.counts[index] ?? 0);
    });
  }

  /** Ключи по порядку строк: одинаковый набор — одинаковые данные при любом порядке слияния. */
  toPlain(): UsagePlain {
    const keys = [...this.#counts.keys()].sort();
    return { bands: this.#bands, rounds: this.#rounds, keys, counts: keys.map((key) => this.#counts.get(key) ?? 0) };
  }
}

/** Итог таблицы на наборе: всё — природное, до книги. */
export interface TableOutcome {
  readonly rounds: number;
  /** Σ выплат с капом, сотые доли ставки. */
  readonly payX100: number;
  readonly baseX100: number;
  readonly featureX100: number;
  /** Раундов с выплатой больше ставки (строго больше 100). */
  readonly overBet: number;
  readonly wins: number;
  readonly features: number;
  /** Раундов, дошедших до капа. */
  readonly caps: number;
}

/**
 * Набор векторов в плоских массивах для быстрой оценки любой таблицы: клетки и суммы подряд, границы векторов,
 * число раундов на вектор.
 */
export class UsageTable {
  readonly bands: number;
  readonly rounds: number;
  readonly #offsets: Uint32Array;
  readonly #cells: Uint8Array;
  readonly #sums: Float64Array;
  readonly #counts: Float64Array;
  readonly #featured: Uint8Array;
  readonly #perPhase: number;

  constructor(plain: UsagePlain) {
    this.bands = plain.bands;
    this.rounds = plain.rounds;
    this.#perPhase = phaseCells(plain.bands);
    const vectors = plain.keys.length;
    const bodies = plain.keys.map((key) => (key.startsWith(FEATURED) ? key.slice(FEATURED.length) : key));
    let entries = 0;
    for (const body of bodies) entries += body === '' ? 0 : body.split(',').length;
    this.#offsets = new Uint32Array(vectors + 1);
    this.#cells = new Uint8Array(entries);
    this.#sums = new Float64Array(entries);
    this.#counts = new Float64Array(vectors);
    this.#featured = new Uint8Array(vectors);
    let at = 0;
    plain.keys.forEach((key, index) => {
      this.#offsets[index] = at;
      this.#counts[index] = plain.counts[index] ?? 0;
      this.#featured[index] = key.startsWith(FEATURED) ? 1 : 0;
      const body = bodies[index] ?? '';
      if (body === '') return;
      for (const part of body.split(',')) {
        const [cell, sum] = part.split(':');
        const cellIndex = Number(cell);
        const value = Number(sum);
        if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= 2 * this.#perPhase || !Number.isSafeInteger(value) || value < 1) {
          throw new RangeError(`испорченный вектор: ${key}`);
        }
        this.#cells[at] = cellIndex;
        this.#sums[at] = value;
        at += 1;
      }
    });
    this.#offsets[vectors] = at;
  }

  /** Выплаты раундов с капом capX100 при таблице table — точно, в целых. */
  evaluate(table: readonly (readonly number[])[], capX100: number): TableOutcome {
    const bands = this.bands;
    const flat = new Float64Array(2 * this.#perPhase);
    for (let phase = 0; phase < 2; phase++) {
      table.forEach((row, symbol) => {
        row.forEach((value, band) => {
          flat[phase * this.#perPhase + symbol * bands + band] = value;
        });
      });
    }
    let payX100 = 0;
    let baseX100 = 0;
    let featureX100 = 0;
    let overBet = 0;
    let wins = 0;
    let features = 0;
    let caps = 0;
    const vectors = this.#counts.length;
    for (let index = 0; index < vectors; index++) {
      const count = this.#counts[index] ?? 0;
      const from = this.#offsets[index] ?? 0;
      const to = this.#offsets[index + 1] ?? 0;
      let base = 0;
      let feature = 0;
      for (let at = from; at < to; at++) {
        const cell = this.#cells[at] ?? 0;
        const paid = (flat[cell] ?? 0) * (this.#sums[at] ?? 0);
        if (cell < this.#perPhase) base += paid;
        else feature += paid;
      }
      // Кап режет основную игру первой, фичу — остатком до капа (как StatsRecorder); кап в основной игре фичу не
      // открывает (§4.2 п. 7).
      const baseCapped = Math.min(base, capX100);
      const featureCapped = Math.min(feature, capX100 - baseCapped);
      const total = baseCapped + featureCapped;
      payX100 += total * count;
      baseX100 += baseCapped * count;
      featureX100 += featureCapped * count;
      if (total > 100) overBet += count;
      if (total > 0) wins += count;
      if (this.#featured[index] === 1 && base < capX100) features += count;
      if (total >= capX100) caps += count;
    }
    return { rounds: this.rounds, payX100, baseX100, featureX100, overBet, wins, features, caps };
  }
}
