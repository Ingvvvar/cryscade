import type { GameConfig, SpinMode } from '../model/config.ts';
import { Board } from './board.ts';
import { ClusterFinder, ClusterTable } from './clusters.ts';
import { Paytable } from './paytable.ts';
import type { RoundRecorder } from './recorder.ts';
import type { SymbolSource } from './source.ts';
import { SpotField } from './spots.ts';

/**
 * Раунд §4.2: спин основной игры и вся фича, которую он открыл. Источник символов и рекордер приходят
 * снаружи, остальные части движок создаёт сам. Буферы живут в экземпляре: один движок — все раунды.
 */
export class RoundEngine {
  readonly #source: SymbolSource;
  readonly #recorder: RoundRecorder;
  readonly #paytable: Paytable;
  readonly #finder: ClusterFinder;
  readonly #board = new Board();
  readonly #clusters = new ClusterTable();
  readonly #spots = new SpotField();
  readonly #freeSpinsByScatters: readonly number[];
  readonly #retriggerMin: number;
  readonly #retriggerAdd: number;
  readonly #capX100: number;
  #totalX100 = 0;

  constructor(config: GameConfig, source: SymbolSource, recorder: RoundRecorder) {
    validateFeature(config);
    this.#source = source;
    this.#recorder = recorder;
    this.#paytable = new Paytable(config);
    this.#finder = new ClusterFinder(config.clusterMin);
    this.#freeSpinsByScatters = [...config.freeSpinsByScatters];
    this.#retriggerMin = config.retrigger.min;
    this.#retriggerAdd = config.retrigger.add;
    this.#capX100 = config.capX100;
  }

  /** Играет раунд и возвращает итог в сотых долях ставки: min(кап, сумма выплат). */
  play(): number {
    this.#recorder.begin();
    this.#totalX100 = 0;
    // Основной спин в раунде один: сброс в начале раунда — это сброс в начале каждого спина основной игры.
    this.#spots.reset();
    if (this.#spin('base')) this.#feature();
    this.#recorder.end(this.#totalX100);
    return this.#totalX100;
  }

  #feature(): void {
    const recorder = this.#recorder;
    const scatters = this.#board.collectScatters();
    const table = this.#freeSpinsByScatters;
    const spins = table[Math.min(scatters.count, table.length - 1)] ?? 0;
    if (spins === 0) return;
    recorder.scatters(scatters);
    recorder.fsStart(spins);
    // Фича начинается с чистого поля и держит его до конца (§4.3).
    this.#spots.reset();
    let left = spins;
    for (let index = 1; left > 0; index++) {
      left -= 1;
      recorder.fsSpin(index, left);
      if (!this.#spin('free')) return;
      const again = this.#board.collectScatters();
      if (again.count >= this.#retriggerMin) {
        left += this.#retriggerAdd;
        recorder.scatters(again);
        recorder.fsRetrigger(this.#retriggerAdd);
      }
    }
  }

  /** Спин и цепочка каскадов. false — раунд упёрся в кап: дальше ни шага и ни одного запроса к источнику. */
  #spin(mode: SpinMode): boolean {
    const board = this.#board;
    const clusters = this.#clusters;
    const recorder = this.#recorder;
    board.fill(this.#source, mode);
    recorder.fill(board);
    while (this.#finder.find(board, clusters) > 0) {
      // Множители — по уровням до взрыва; кластеры шага не пересекаются, порядок не важен.
      let stepX100 = 0;
      for (let cluster = 0; cluster < clusters.count; cluster++) {
        const mult = this.#spots.multiplier(clusters, cluster);
        const payX100 = this.#paytable.payX100(clusters.symbol(cluster), clusters.size(cluster)) * mult;
        clusters.price(cluster, mult, payX100);
        stepX100 += payX100;
      }
      recorder.win(clusters);
      this.#totalX100 += stepX100;
      if (this.#totalX100 >= this.#capX100) {
        // Кластеры шага подсвечены, но не взрываются: итоговая сетка полная (§4.2 п. 7).
        this.#totalX100 = this.#capX100;
        recorder.cap();
        return false;
      }
      board.explode(clusters);
      recorder.explode(board.exploded);
      this.#spots.bump(board.exploded);
      recorder.spots(this.#spots);
      board.collapse(this.#source, mode);
      recorder.refill(board);
    }
    return true;
  }
}

function validateFeature(config: GameConfig): void {
  const table = config.freeSpinsByScatters;
  if (table.length === 0) throw new RangeError('freeSpinsByScatters: пустая таблица');
  for (let count = 0; count < table.length; count++) {
    const spins = table[count] ?? -1;
    if (!Number.isSafeInteger(spins) || spins < 0) {
      throw new RangeError(`freeSpinsByScatters[${String(count)}]: ожидается неотрицательное целое, получено ${String(spins)}`);
    }
  }
  const { min, add } = config.retrigger;
  if (!Number.isSafeInteger(min) || min < 1 || !Number.isSafeInteger(add) || add < 1) {
    throw new RangeError(`retrigger: min и add — целые от 1, получено ${String(min)} и ${String(add)}`);
  }
  if (!Number.isSafeInteger(config.capX100) || config.capX100 < 1) {
    throw new RangeError(`capX100: ожидается целое от 1, получено ${String(config.capX100)}`);
  }
}
