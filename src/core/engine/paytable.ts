import type { GameConfig } from '../model/config.ts';
import { CELL_COUNT } from '../model/grid.ts';
import { PAYING_SYMBOL_COUNT } from '../model/symbols.ts';

const SIZES = CELL_COUNT + 1;
const U32_MAX = 0xffffffff;

/** Выплата кластера по символу и размеру: полосы §4.4 развёрнуты в таблицу, поиск за O(1). */
export class Paytable {
  readonly #bySize = new Uint32Array(PAYING_SYMBOL_COUNT * SIZES);

  constructor(config: Pick<GameConfig, 'clusterMin' | 'sizeBands' | 'paytableX100'>) {
    validate(config);
    const bands = config.sizeBands;
    for (let symbol = 0; symbol < PAYING_SYMBOL_COUNT; symbol++) {
      const row = config.paytableX100[symbol] ?? [];
      let band = 0;
      for (let size = config.clusterMin; size <= CELL_COUNT; size++) {
        while (band + 1 < bands.length && size >= (bands[band + 1] ?? SIZES)) band += 1;
        this.#bySize[symbol * SIZES + size] = row[band] ?? 0;
      }
    }
  }

  /** Сотые доли ставки до множителя. Размер меньше кластера — 0. */
  payX100(symbol: number, size: number): number {
    return this.#bySize[symbol * SIZES + size] ?? 0;
  }
}

function validate(config: Pick<GameConfig, 'clusterMin' | 'sizeBands' | 'paytableX100'>): void {
  const { clusterMin, sizeBands, paytableX100 } = config;
  if (!Number.isInteger(clusterMin) || clusterMin < 2 || clusterMin > CELL_COUNT) {
    throw new RangeError(`clusterMin: ожидается целое от 2 до ${String(CELL_COUNT)}, получено ${String(clusterMin)}`);
  }
  if (sizeBands[0] !== clusterMin) {
    throw new RangeError(`sizeBands: первая полоса должна начинаться с clusterMin = ${String(clusterMin)}`);
  }
  for (let band = 1; band < sizeBands.length; band++) {
    const lower = sizeBands[band] ?? 0;
    if (!Number.isInteger(lower) || lower <= (sizeBands[band - 1] ?? 0) || lower > CELL_COUNT) {
      throw new RangeError(`sizeBands[${String(band)}]: полосы — целые по возрастанию до ${String(CELL_COUNT)}`);
    }
  }
  if (paytableX100.length !== PAYING_SYMBOL_COUNT) {
    throw new RangeError(`paytableX100: ожидается ${String(PAYING_SYMBOL_COUNT)} строк, получено ${String(paytableX100.length)}`);
  }
  for (let symbol = 0; symbol < PAYING_SYMBOL_COUNT; symbol++) {
    const row = paytableX100[symbol];
    if (row === undefined || row.length !== sizeBands.length) {
      throw new RangeError(`paytableX100[${String(symbol)}]: ожидается ${String(sizeBands.length)} значений`);
    }
    for (let band = 0; band < row.length; band++) {
      const value = row[band] ?? -1;
      if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
        throw new RangeError(`paytableX100[${String(symbol)}][${String(band)}]: ожидается целое от 0 до 2^32 − 1`);
      }
    }
  }
}
