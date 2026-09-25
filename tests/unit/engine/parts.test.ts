import { describe, expect, it } from 'vitest';
import { CellList } from '../../../src/core/engine/cell-list.ts';
import { ClusterFinder, ClusterTable } from '../../../src/core/engine/clusters.ts';
import { EventRecorder, RngSymbolSource, RoundEngine, SeededEngine, WeightedPicker, type SymbolSource } from '../../../src/core/engine/index.ts';
import { Paytable } from '../../../src/core/engine/paytable.ts';
import { SpotField } from '../../../src/core/engine/spots.ts';
import { DEFAULT_CONFIG, type GameConfig } from '../../../src/core/model/config.ts';
import { Xoshiro128ss, type Random } from '../../../src/core/rng/index.ts';
import { TEST_CONFIG } from '../../support/configs.ts';
import { BACKGROUND, grid } from '../../support/scenario.ts';

/** Отдаёт заданные слова по порядку и считает, сколько взято. Лишнее слово — ошибка. */
class ScriptedRandom implements Random {
  readonly #words: readonly number[];
  #used = 0;

  constructor(words: readonly number[]) {
    this.#words = words;
  }

  get used(): number {
    return this.#used;
  }

  nextU32(): number {
    const word = this.#words[this.#used];
    if (word === undefined) throw new Error('ScriptedRandom: слова кончились');
    this.#used += 1;
    return word;
  }
}

const UNIFORM = [1, 1, 1, 1, 1, 1, 1, 1];

describe('WeightedPicker', () => {
  it('u32 mod W по накопленным весам; символ с весом 0 не выпадает', () => {
    // Веса 1, 2, 3, 0, 4, 0, 0, 6: W = 16 делит 2^32 — отбрасывания нет.
    const words = [...Array.from({ length: 16 }, (_, x) => x), 16, 0xffffffff];
    const random = new ScriptedRandom(words);
    const picker = new WeightedPicker([1, 2, 3, 0, 4, 0, 0, 6]);
    expect(words.map(() => picker.pick(random))).toStrictEqual([0, 1, 1, 2, 2, 2, 4, 4, 4, 4, 7, 7, 7, 7, 7, 7, 0, 7]);
  });

  it('W = 3: 2^32 mod 3 = 1, граница 2^32 − 1 — последнее слово отбрасывается', () => {
    const picker = new WeightedPicker([1, 1, 1, 0, 0, 0, 0, 0]);
    const rejected = new ScriptedRandom([0xffffffff, 5]);
    expect(picker.pick(rejected)).toBe(2); // 5 mod 3
    expect(rejected.used).toBe(2);
    const accepted = new ScriptedRandom([0xfffffffe]);
    expect(picker.pick(accepted)).toBe(2); // 4294967294 mod 3
    expect(accepted.used).toBe(1);
  });

  it('W = 7: 2^32 mod 7 = 4, граница 4294967292 отбрасывается, на единицу меньше — нет', () => {
    const picker = new WeightedPicker([1, 1, 1, 1, 1, 1, 1, 0]);
    const random = new ScriptedRandom([4294967292, 4294967291]);
    expect(picker.pick(random)).toBe(6); // 4294967291 mod 7
    expect(random.used).toBe(2);
  });

  it('сумма ровно 2^32 допустима и ничего не отбрасывает', () => {
    const picker = new WeightedPicker([2 ** 32, 0, 0, 0, 0, 0, 0, 0]);
    const random = new ScriptedRandom([0xffffffff]);
    expect(picker.pick(random)).toBe(0);
    expect(random.used).toBe(1);
  });

  it.each([
    ['7 весов', [1, 1, 1, 1, 1, 1, 1]],
    ['9 весов', [1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ['отрицательный', [1, 1, 1, -1, 1, 1, 1, 1]],
    ['дробный', [1, 1, 1, 1.5, 1, 1, 1, 1]],
    ['NaN', [1, 1, 1, Number.NaN, 1, 1, 1, 1]],
    ['все нули', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['сумма больше 2^32', [2 ** 32, 1, 0, 0, 0, 0, 0, 0]],
  ])('%s — RangeError', (_name, weights) => {
    expect(() => new WeightedPicker(weights)).toThrow(RangeError);
  });
});

describe('RngSymbolSource', () => {
  it('основная игра и фриспины берут символы из своих распределений', () => {
    const source: SymbolSource = new RngSymbolSource(
      { base: [1, 0, 0, 0, 0, 0, 0, 0], free: [0, 0, 0, 0, 0, 0, 0, 1] },
      new ScriptedRandom([11, 22, 33]),
    );
    expect(source.next('base', 0)).toBe(0);
    expect(source.next('free', 0)).toBe(7);
    expect(source.next('base', 48)).toBe(0);
  });
});

describe('порядок обращений к ГСЧ', () => {
  it('заполнение — клетки 0…48 по порядку, досыпка — пустые клетки по возрастанию', () => {
    // Веса поровну, W = 8: слово меньше 8 и есть символ. Первые 49 слов — сетка столбца Бриллиантов,
    // следующие 5 — досыпка R A E R A в клетки 3, 10, 17, 24, 31.
    const fillWords = grid(['QACESRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ']);
    const random = new ScriptedRandom([...fillWords, 5, 1, 3, 5, 1]);
    const recorder = new EventRecorder();
    const engine = new RoundEngine(TEST_CONFIG, new RngSymbolSource({ base: UNIFORM, free: UNIFORM }, random), recorder);

    expect(engine.play()).toBe(100);
    expect(recorder.events[0]).toStrictEqual({ t: 'fill', grid: fillWords });
    expect(recorder.events.find((event) => event.t === 'refill')).toStrictEqual({
      t: 'refill',
      moves: [
        [10, 45],
        [3, 38],
      ],
      drops: [
        { cell: 3, symbol: 5 },
        { cell: 10, symbol: 1 },
        { cell: 17, symbol: 3 },
        { cell: 24, symbol: 5 },
        { cell: 31, symbol: 1 },
      ],
    });
    expect(random.used).toBe(54);
  });
});

describe('Paytable', () => {
  const table = new Paytable(TEST_CONFIG);

  it.each([
    [0, 4, 0],
    [0, 5, 20],
    [0, 6, 20],
    [0, 7, 40],
    [0, 8, 40],
    [0, 9, 80],
    [0, 10, 80],
    [0, 11, 150],
    [0, 12, 150],
    [0, 13, 300],
    [0, 14, 300],
    [0, 15, 600],
    [0, 49, 600],
    [6, 5, 100],
    [6, 7, 250],
    [6, 15, 10000],
    [6, 49, 10000],
  ])('символ %i, размер %i → %i', (symbol, size, payX100) => {
    expect(table.payX100(symbol, size)).toBe(payX100);
  });

  const broken = (patch: Partial<GameConfig>): GameConfig => ({ ...TEST_CONFIG, ...patch });
  const rows = TEST_CONFIG.paytableX100;
  it.each([
    ['clusterMin 1', broken({ clusterMin: 1, sizeBands: [1, 7, 9, 11, 13, 15] })],
    ['clusterMin 50', broken({ clusterMin: 50 })],
    ['clusterMin 4.5', broken({ clusterMin: 4.5 })],
    ['полосы не с clusterMin', broken({ sizeBands: [6, 7, 9, 11, 13, 15] })],
    ['полосы не по возрастанию', broken({ sizeBands: [5, 7, 7, 11, 13, 15] })],
    ['полоса за 49', broken({ sizeBands: [5, 7, 9, 11, 13, 50] })],
    ['6 строк таблицы', broken({ paytableX100: rows.slice(0, 6) })],
    ['строка из 5 значений', broken({ paytableX100: [rows[0]?.slice(0, 5) ?? [], ...rows.slice(1)] })],
    ['отрицательная выплата', broken({ paytableX100: [[-20, 40, 80, 150, 300, 600], ...rows.slice(1)] })],
    ['дробная выплата', broken({ paytableX100: [[20.5, 40, 80, 150, 300, 600], ...rows.slice(1)] })],
    ['выплата больше u32', broken({ paytableX100: [[2 ** 32, 40, 80, 150, 300, 600], ...rows.slice(1)] })],
  ])('%s — RangeError', (_name, config) => {
    expect(() => new Paytable(config)).toThrow(RangeError);
  });
});

function clustersOf(rows: readonly string[]): { symbol: number; cells: number[] }[] {
  const cells = grid(rows);
  const table = new ClusterTable();
  new ClusterFinder(5).find({ symbolAt: (cell) => cells[cell] ?? -1 }, table);
  return Array.from({ length: table.count }, (_, cluster) => ({
    symbol: table.symbol(cluster),
    cells: Array.from({ length: table.size(cluster) }, (_, index) => table.cellAt(cluster, index)),
  }));
}

describe('ClusterFinder', () => {
  it('столбец из 5', () => {
    expect(clustersOf(['QACESRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ'])).toStrictEqual([
      { symbol: 6, cells: [17, 24, 31, 38, 45] },
    ]);
  });

  it('касание по диагонали не связывает; кластеры по наименьшей клетке', () => {
    expect(clustersOf(['QACESDD', 'CEDDDDD', 'SDQACES', 'QDCESRQ', 'CDSRQAC', 'SDQACES', 'QDCESRQ'])).toStrictEqual([
      { symbol: 6, cells: [5, 6, 9, 10, 11, 12, 13] },
      { symbol: 6, cells: [15, 22, 29, 36, 43] },
    ]);
  });

  it('кольцо — кластер без центра', () => {
    expect(clustersOf(['QACESRQ', 'CESRQAC', 'SRQACES', 'QACESRQ', 'DDDRQAC', 'DRDACES', 'DDDESRQ'])).toStrictEqual([
      { symbol: 6, cells: [28, 29, 30, 35, 37, 42, 43, 44] },
    ]);
  });

  it('ядра кластеров не образуют', () => {
    expect(clustersOf([...BACKGROUND.slice(0, 5), '*****ES', '*****RQ'])).toStrictEqual([]);
  });

  it('две группы по 4 — не кластеры', () => {
    expect(clustersOf(['DDCESRQ', 'DDSRQAC', 'SRQACES', 'QACESRQ', 'CESRQAC', 'SRQACDD', 'QACESDD'])).toStrictEqual([]);
  });

  it('вся сетка одним символом — один кластер из 49 клеток', () => {
    expect(clustersOf(Array.from({ length: 7 }, () => 'SSSSSSS'))).toStrictEqual([
      { symbol: 4, cells: Array.from({ length: 49 }, (_, cell) => cell) },
    ]);
  });

  it.each([1, 50, 2.5])('clusterMin %s — RangeError', (clusterMin) => {
    expect(() => new ClusterFinder(clusterMin)).toThrow(RangeError);
  });
});

function cellsOf(...cells: number[]): CellList {
  const list = new CellList(49);
  for (const cell of cells) list.push(cell);
  return list;
}

describe('SpotField', () => {
  it('нет → отметка → ×2 → … → ×128, дальше не растёт и в изменения не попадает', () => {
    const spots = new SpotField();
    const levels: number[] = [];
    const changed: number[] = [];
    for (let explosion = 0; explosion < 9; explosion++) {
      spots.bump(cellsOf(12));
      levels.push(spots.levelOf(12));
      changed.push(spots.count);
    }
    expect(levels).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 8]);
    expect(changed).toStrictEqual([1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  it('множитель: ×4 + ×2 + отметка + две пустые = ×6; только отметки — ×1; ×128 — 128', () => {
    const spots = new SpotField();
    spots.bump(cellsOf(0, 1, 2));
    spots.bump(cellsOf(0, 1));
    spots.bump(cellsOf(0));
    const table = new ClusterTable();
    table.add(6, Uint8Array.of(0, 1, 2, 3, 4), 5); // уровни 3, 2, 1, 0, 0
    table.add(6, Uint8Array.of(2, 10, 11, 12, 13), 5); // только отметка
    expect(spots.multiplier(table, 0)).toBe(6);
    expect(spots.multiplier(table, 1)).toBe(1);

    for (let explosion = 0; explosion < 8; explosion++) spots.bump(cellsOf(20));
    const top = new ClusterTable();
    top.add(6, Uint8Array.of(20, 21, 22, 23, 24), 5);
    expect(spots.multiplier(top, 0)).toBe(128);
  });

  it('изменения — клетки последнего взрыва с новыми уровнями; reset чистит всё', () => {
    const spots = new SpotField();
    spots.bump(cellsOf(3, 9));
    spots.bump(cellsOf(3, 17));
    expect([spots.count, spots.cellAt(0), spots.levelAt(0), spots.cellAt(1), spots.levelAt(1)]).toStrictEqual([2, 3, 2, 17, 1]);
    spots.reset();
    expect([spots.count, spots.levelOf(3), spots.levelOf(9), spots.levelOf(17)]).toStrictEqual([0, 0, 0, 0]);
  });
});

describe('CellList', () => {
  it('сверх ёмкости — RangeError, а не молчаливая запись мимо', () => {
    const list = cellsOf(1, 2);
    expect(() => {
      const small = new CellList(2);
      small.push(1);
      small.push(2);
      small.push(3);
    }).toThrow(RangeError);
    list.clear();
    expect(list.count).toBe(0);
  });
});

describe('RoundEngine: проверки на входе', () => {
  const never: SymbolSource = {
    next: () => {
      throw new Error('не должен вызываться');
    },
  };
  const broken = (patch: Partial<GameConfig>): GameConfig => ({ ...TEST_CONFIG, ...patch });

  it.each([
    ['пустая таблица фриспинов', broken({ freeSpinsByScatters: [] })],
    ['отрицательные фриспины', broken({ freeSpinsByScatters: [0, 0, 0, -10] })],
    ['дробные фриспины', broken({ freeSpinsByScatters: [0, 0, 0, 10.5] })],
    ['ретриггер от 0 ядер', broken({ retrigger: { min: 0, add: 5 } })],
    ['ретриггер +0', broken({ retrigger: { min: 3, add: 0 } })],
    ['кап 0', broken({ capX100: 0 })],
    ['дробный кап', broken({ capX100: 1.5 })],
  ])('%s — RangeError', (_name, config) => {
    expect(() => new RoundEngine(config, never, new EventRecorder())).toThrow(RangeError);
  });

  // Плохой символ — в одной клетке мёртвой сетки: без проверки раунд закончился бы молча, а не бесконечным каскадом.
  it.each([8, -1, 1.5, Number.NaN])('источник вернул %s — RangeError', (bad) => {
    const cells = grid(BACKGROUND);
    const source: SymbolSource = { next: (_mode, cell) => (cell === 24 ? bad : (cells[cell] ?? 0)) };
    const engine = new RoundEngine(TEST_CONFIG, source, new EventRecorder());
    expect(() => engine.play()).toThrow(RangeError);
  });
});

describe('SeededEngine', () => {
  const eventsOf = (engine: SeededEngine, recorder: EventRecorder, seed: number): string => {
    engine.play(seed);
    return JSON.stringify(recorder.events);
  };

  it('раунд по сиду = RoundEngine с RngSymbolSource на Xoshiro128ss от того же сида', () => {
    for (const seed of [0, 1, 2026, 0xffffffff]) {
      const recorder = new EventRecorder();
      const reference = new EventRecorder();
      const expectedTotal = new RoundEngine(
        DEFAULT_CONFIG,
        new RngSymbolSource(DEFAULT_CONFIG.weights, new Xoshiro128ss(seed)),
        reference,
      ).play();
      expect(new SeededEngine(DEFAULT_CONFIG, recorder).play(seed)).toBe(expectedTotal);
      expect(recorder.events).toStrictEqual(reference.events);
    }
  });

  it('пересевает ГСЧ на каждый раунд: сид после чужих раундов даёт тот же раунд', () => {
    const recorder = new EventRecorder();
    const engine = new SeededEngine(DEFAULT_CONFIG, recorder);
    const first = eventsOf(engine, recorder, 7);
    eventsOf(engine, recorder, 8);
    eventsOf(engine, recorder, 9);
    expect(eventsOf(engine, recorder, 7)).toBe(first);
  });

  it('сид вне u32 — RangeError', () => {
    expect(() => new SeededEngine(DEFAULT_CONFIG, new EventRecorder()).play(-1)).toThrow(RangeError);
  });
});
