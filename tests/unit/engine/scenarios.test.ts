import { describe, expect, it } from 'vitest';
import type { RoundEvent } from '../../../src/core/model/events.ts';
import { TEST_CONFIG, withCap } from '../../support/configs.ts';
import { BACKGROUND, deadSpins, drops, fill, grid, gridsAfterSteps, playOne, playScenario } from '../../support/scenario.ts';

// Литеральные сценарии §15. Буквы: Q0 A1 C2 E3 S4 R5 D6 *7, точка — клетка без досыпки.
// Фон BACKGROUND кластеров не даёт; кластеры сценариев — из Бриллианта (D), которого в фоне нет.
// Выплаты Бриллианта по полосам: 5–6 → 100, 7–8 → 250, 9–10 → 500, 11–12 → 1000, 13–14 → 2500, 15+ → 10000.

type Of<T extends RoundEvent['t']> = Extract<RoundEvent, { t: T }>;

function only<T extends RoundEvent['t']>(events: readonly RoundEvent[], t: T): Of<T>[] {
  return events.filter((event): event is Of<T> => event.t === t);
}

const types = (events: readonly RoundEvent[]): string[] => events.map((event) => event.t);

// Столбец Бриллиантов в колонке 3, строки 2–6: клетки 17, 24, 31, 38, 45.
const COLUMN_FILL = ['QACESRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ'];
// После взрыва E и R из строк 0–1 падают на 5–6; досыпка продолжает колонку в тон фону.
const COLUMN_DROPS = ['...R...', '...A...', '...E...', '...R...', '...A...', '.......', '.......'];
// Три ядра в нижней строке: клетки 42, 45, 48.
const THREE_CORES = [...BACKGROUND.slice(0, 6), '*AC*SR*'];

describe('кластер из 5', () => {
  it('полный список событий', () => {
    const events = playOne(TEST_CONFIG, [
      fill('base', [
        'QACESRQ',
        'CESRQAC',
        'SRQDCES',
        'QACDSRQ',
        'CESDQAC',
        'SRQDCES',
        'QACDSRQ',
      ]),
      drops('base', [
        '...R...',
        '...A...',
        '...E...',
        '...R...',
        '...A...',
        '.......',
        '.......',
      ]),
    ]);

    expect(events).toStrictEqual([
      {
        t: 'fill',
        grid: [
          0, 1, 2, 3, 4, 5, 0,
          2, 3, 4, 5, 0, 1, 2,
          4, 5, 0, 6, 2, 3, 4,
          0, 1, 2, 6, 4, 5, 0,
          2, 3, 4, 6, 0, 1, 2,
          4, 5, 0, 6, 2, 3, 4,
          0, 1, 2, 6, 4, 5, 0,
        ],
      },
      { t: 'win', clusters: [{ symbol: 6, cells: [17, 24, 31, 38, 45], payX100: 100, mult: 1 }] },
      { t: 'explode', cells: [17, 24, 31, 38, 45] },
      { t: 'spots', cells: [17, 24, 31, 38, 45], levels: [1, 1, 1, 1, 1] },
      {
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
      },
      { t: 'end', payX100: 100 },
    ]);
  });
});

describe('два кластера сразу', () => {
  it('группы одного символа, касающиеся по диагонали, — два кластера: связность по стороне, не по углу', () => {
    // Группа из 7 справа сверху и столбец из 5 в колонке 1 касаются углами клеток 9 и 15.
    // По восьми соседям это был бы один кластер из 12 с выплатой 1000.
    const events = playOne(TEST_CONFIG, [
      fill('base', ['QACESDD', 'CEDDDDD', 'SDQACES', 'QDCESRQ', 'CDSRQAC', 'SDQACES', 'QDCESRQ']),
      drops('base', ['.EQACRQ', '.R...AC', '.A.....', '.E.....', '.R.....', '.......', '.......']),
    ]);

    expect(events).toStrictEqual([
      { t: 'fill', grid: grid(['QACESDD', 'CEDDDDD', 'SDQACES', 'QDCESRQ', 'CDSRQAC', 'SDQACES', 'QDCESRQ']) },
      {
        t: 'win',
        clusters: [
          { symbol: 6, cells: [5, 6, 9, 10, 11, 12, 13], payX100: 250, mult: 1 },
          { symbol: 6, cells: [15, 22, 29, 36, 43], payX100: 100, mult: 1 },
        ],
      },
      { t: 'explode', cells: [5, 6, 9, 10, 11, 12, 13, 15, 22, 29, 36, 43] },
      { t: 'spots', cells: [5, 6, 9, 10, 11, 12, 13, 15, 22, 29, 36, 43], levels: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
      {
        t: 'refill',
        moves: [
          [8, 43],
          [1, 36],
          [2, 9],
          [3, 10],
          [4, 11],
        ],
        drops: [
          { cell: 1, symbol: 3 },
          { cell: 2, symbol: 0 },
          { cell: 3, symbol: 1 },
          { cell: 4, symbol: 2 },
          { cell: 5, symbol: 5 },
          { cell: 6, symbol: 0 },
          { cell: 8, symbol: 5 },
          { cell: 12, symbol: 1 },
          { cell: 13, symbol: 2 },
          { cell: 15, symbol: 1 },
          { cell: 22, symbol: 3 },
          { cell: 29, symbol: 5 },
        ],
      },
      { t: 'end', payX100: 350 },
    ]);
    expect(gridsAfterSteps(events).at(-1)).toStrictEqual(['QEQACRQ', 'CRCESAC', 'SAQACES', 'QECESRQ', 'CRSRQAC', 'SAQACES', 'QECESRQ']);
  });
});

describe('кластер с дырой', () => {
  it('кольцо из 8 без центра; символ центра падает на дно кольца', () => {
    const events = playOne(TEST_CONFIG, [
      fill('base', ['QACESRQ', 'CESRQAC', 'SRQACES', 'QACESRQ', 'DDDRQAC', 'DRDACES', 'DDDESRQ']),
      drops('base', ['QEC....', 'CRS....', 'S.Q....', '.......', '.......', '.......', '.......']),
    ]);

    expect(only(events, 'win')).toStrictEqual([
      { t: 'win', clusters: [{ symbol: 6, cells: [28, 29, 30, 35, 37, 42, 43, 44], payX100: 250, mult: 1 }] },
    ]);
    expect(only(events, 'refill')[0]?.moves).toStrictEqual([
      [21, 42],
      [14, 35],
      [7, 28],
      [0, 21],
      [36, 43], // центр кольца, R, — на дно
      [22, 36],
      [15, 29],
      [8, 22],
      [1, 15],
      [23, 44],
      [16, 37],
      [9, 30],
      [2, 23],
    ]);
    expect(gridsAfterSteps(events).at(-1)).toStrictEqual(['QECESRQ', 'CRSRQAC', 'SAQACES', 'QECESRQ', 'CRSRQAC', 'SAQACES', 'QRCESRQ']);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 250 }]);
  });
});

describe('каскад в три шага', () => {
  it('второй кластер собирается падением колонок на разную высоту, третий — досыпкой', () => {
    // Шаг 1: уголок из 5 внизу слева. После него колонки 0–1 опускаются на 2, колонка 2 — на 1,
    // и разрозненные Бриллианты (пара, одиночка, пара) встают в строку 5 подряд.
    const events = playOne(TEST_CONFIG, [
      fill('base', ['QACESRQ', 'CESRQAC', 'SRQACES', 'DDCESRQ', 'CEDRQAC', 'DDQDDES', 'DDDESRQ']),
      drops('base', ['CEQ....', 'SR.....', '.......', '.......', '.......', '.......', '.......']),
      drops('base', ['DDDDD..', '.......', '.......', '.......', '.......', '.......', '.......']),
      drops('base', ['QASAC..', '.......', '.......', '.......', '.......', '.......', '.......']),
    ]);

    expect(types(events)).toStrictEqual([
      'fill',
      ...['win', 'explode', 'spots', 'refill'],
      ...['win', 'explode', 'spots', 'refill'],
      ...['win', 'explode', 'spots', 'refill'],
      'end',
    ]);
    expect(only(events, 'win').map((event) => event.clusters)).toStrictEqual([
      [{ symbol: 6, cells: [35, 36, 42, 43, 44], payX100: 100, mult: 1 }],
      [{ symbol: 6, cells: [35, 36, 37, 38, 39], payX100: 100, mult: 1 }],
      [{ symbol: 6, cells: [0, 1, 2, 3, 4], payX100: 100, mult: 1 }],
    ]);
    // Клетки 35 и 36 взрываются второй раз: отметка → ×2. Множитель шага 2 — по уровням до взрыва, ×1.
    expect(only(events, 'spots').map(({ cells, levels }) => ({ cells, levels }))).toStrictEqual([
      { cells: [35, 36, 42, 43, 44], levels: [1, 1, 1, 1, 1] },
      { cells: [35, 36, 37, 38, 39], levels: [2, 2, 1, 1, 1] },
      { cells: [0, 1, 2, 3, 4], levels: [1, 1, 1, 1, 1] },
    ]);
    expect(gridsAfterSteps(events)).toStrictEqual([
      ['QACESRQ', 'CESRQAC', 'SRQACES', 'DDCESRQ', 'CEDRQAC', 'DDQDDES', 'DDDESRQ'],
      ['CEQESRQ', 'SRCRQAC', 'QASACES', 'CEQESRQ', 'SRCRQAC', 'DDDDDES', 'CEQESRQ'],
      ['DDDDDRQ', 'CEQESAC', 'SRCRQES', 'QASACRQ', 'CEQESAC', 'SRCRQES', 'CEQESRQ'],
      ['QASACRQ', 'CEQESAC', 'SRCRQES', 'QASACRQ', 'CEQESAC', 'SRCRQES', 'CEQESRQ'],
    ]);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 300 }]);
  });
});

describe('точки множителей', () => {
  it('отметка → ×2 → ×4: уровни растут, множитель считается по уровням до взрыва', () => {
    // Верхняя строка, клетки 0–4: досыпка возвращает Бриллианты на те же клетки три раза подряд.
    const again = drops('base', ['DDDDD..', '.......', '.......', '.......', '.......', '.......', '.......']);
    const events = playOne(TEST_CONFIG, [
      fill('base', ['DDDDDRQ', ...BACKGROUND.slice(1)]),
      again,
      again,
      again,
      drops('base', ['QACES..', '.......', '.......', '.......', '.......', '.......', '.......']),
    ]);

    // Шаг 1: уровни 0 → ×1. Шаг 2: отметки не множители → ×1. Шаг 3: пять клеток по ×2 → ×10. Шаг 4: пять по ×4 → ×20.
    expect(only(events, 'win').map((event) => event.clusters)).toStrictEqual([
      [{ symbol: 6, cells: [0, 1, 2, 3, 4], payX100: 100, mult: 1 }],
      [{ symbol: 6, cells: [0, 1, 2, 3, 4], payX100: 100, mult: 1 }],
      [{ symbol: 6, cells: [0, 1, 2, 3, 4], payX100: 1000, mult: 10 }],
      [{ symbol: 6, cells: [0, 1, 2, 3, 4], payX100: 2000, mult: 20 }],
    ]);
    expect(only(events, 'spots').map((event) => event.levels)).toStrictEqual([
      [1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2],
      [3, 3, 3, 3, 3],
      [4, 4, 4, 4, 4],
    ]);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 3200 }]);
  });

  it('множитель кластера — сумма множителей его клеток, отметки не считаются', () => {
    // Колонка 3 целиком: 7, потом нижние 5, потом дважды верхние 5 — уровни в колонке расходятся.
    const top = drops('base', ['...D...', '...D...', '...D...', '...D...', '...D...', '.......', '.......']);
    const events = playOne(TEST_CONFIG, [
      fill('base', ['QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ']),
      drops('base', ['...E...', '...R...', '...D...', '...D...', '...D...', '...D...', '...D...']),
      top,
      top,
      drops('base', COLUMN_DROPS),
    ]);

    expect(only(events, 'win').map((event) => event.clusters)).toStrictEqual([
      [{ symbol: 6, cells: [3, 10, 17, 24, 31, 38, 45], payX100: 250, mult: 1 }],
      // Все пять — отметки: ×1.
      [{ symbol: 6, cells: [17, 24, 31, 38, 45], payX100: 100, mult: 1 }],
      // 3, 10 — отметки (0), 17, 24, 31 — ×2: 0 + 0 + 2 + 2 + 2.
      [{ symbol: 6, cells: [3, 10, 17, 24, 31], payX100: 600, mult: 6 }],
      // 3, 10 — ×2, 17, 24, 31 — ×4: 2 + 2 + 4 + 4 + 4.
      [{ symbol: 6, cells: [3, 10, 17, 24, 31], payX100: 1600, mult: 16 }],
    ]);
    expect(only(events, 'spots').map(({ cells, levels }) => ({ cells, levels }))).toStrictEqual([
      { cells: [3, 10, 17, 24, 31, 38, 45], levels: [1, 1, 1, 1, 1, 1, 1] },
      { cells: [17, 24, 31, 38, 45], levels: [2, 2, 2, 2, 2] },
      { cells: [3, 10, 17, 24, 31], levels: [2, 2, 3, 3, 3] },
      { cells: [3, 10, 17, 24, 31], levels: [3, 3, 4, 4, 4] },
    ]);
    expect(only(events, 'refill').map((event) => event.moves)).toStrictEqual([
      [],
      [
        [10, 45],
        [3, 38],
      ],
      [],
      [],
    ]);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 2550 }]);
  });

  it('между спинами основной игры точки сбрасываются: второй раунд на том же движке начинает с нуля', () => {
    const round = [fill('base', COLUMN_FILL), drops('base', COLUMN_DROPS)];
    const [first, second] = playScenario(TEST_CONFIG, [...round, ...round], 2);

    expect(only(first ?? [], 'spots')).toStrictEqual([{ t: 'spots', cells: [17, 24, 31, 38, 45], levels: [1, 1, 1, 1, 1] }]);
    expect(only(second ?? [], 'spots')).toStrictEqual([{ t: 'spots', cells: [17, 24, 31, 38, 45], levels: [1, 1, 1, 1, 1] }]);
    expect(second).toStrictEqual(first);
  });

  it('фича начинается с чистого поля, а внутри фичи точки живут от спина к спину', () => {
    const column = [fill('free', COLUMN_FILL), drops('free', COLUMN_DROPS)];
    const events = playOne(TEST_CONFIG, [
      fill('base', ['*ACESR*', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSR*']),
      drops('base', COLUMN_DROPS),
      ...column,
      ...column,
      ...column,
      ...deadSpins(7),
    ]);

    expect(only(events, 'scatters')).toStrictEqual([{ t: 'scatters', cells: [0, 6, 48] }]);
    expect(only(events, 'fsStart')).toStrictEqual([{ t: 'fsStart', spins: 10 }]);
    // Основной спин, фриспины 1, 2, 3 — те же пять клеток.
    expect(only(events, 'spots').map((event) => event.levels)).toStrictEqual([
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1], // чистое поле: отметки основного спина в фичу не перешли
      [2, 2, 2, 2, 2], // отметки фриспина 1 дожили до фриспина 2
      [3, 3, 3, 3, 3],
    ]);
    expect(only(events, 'win').map((event) => event.clusters[0]?.mult)).toStrictEqual([1, 1, 1, 10]);
    expect(only(events, 'fsSpin')).toHaveLength(10);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 1300 }]);
  });
});

describe('ядра и фриспины', () => {
  it.each([
    [2, 0],
    [3, 10],
    [4, 12],
    [5, 15],
    [6, 20],
    [7, 20],
  ])('%i ядер подряд в нижней строке → %i фриспинов, кластера из ядер нет', (count, spins) => {
    const cores = [...BACKGROUND.slice(0, 6), '*'.repeat(count) + (BACKGROUND[6] ?? '').slice(count)];
    const events = playOne(TEST_CONFIG, [fill('base', cores), ...deadSpins(spins)]);

    expect(only(events, 'win')).toStrictEqual([]);
    expect(only(events, 'fsStart')).toStrictEqual(spins === 0 ? [] : [{ t: 'fsStart', spins }]);
    expect(only(events, 'scatters')).toStrictEqual(
      spins === 0 ? [] : [{ t: 'scatters', cells: Array.from({ length: count }, (_, index) => 42 + index) }],
    );
    expect(only(events, 'fsSpin')).toHaveLength(spins);
  });

  it('ядро падает вместе с остальными, досыпанное ядро считается в конце цепочки', () => {
    // В начале два ядра: 3 (над столбцом) и 42. Третье приходит досыпкой.
    const events = playOne(TEST_CONFIG, [
      fill('base', ['QAC*SRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', '*ACDSRQ']),
      drops('base', ['...*...', '...A...', '...E...', '...R...', '...A...', '.......', '.......']),
      ...deadSpins(10),
    ]);

    expect(only(events, 'refill')[0]?.moves).toStrictEqual([
      [10, 45],
      [3, 38], // ядро
    ]);
    expect(gridsAfterSteps(events)[1]).toStrictEqual(['QAC*SRQ', 'CESAQAC', 'SRQECES', 'QACRSRQ', 'CESAQAC', 'SRQ*CES', '*ACRSRQ']);
    expect(only(events, 'scatters')).toStrictEqual([{ t: 'scatters', cells: [3, 38, 42] }]);
    expect(only(events, 'fsStart')).toStrictEqual([{ t: 'fsStart', spins: 10 }]);
  });

  it('ретриггер: +5 за 3 и больше ядер, в том числе на последнем спине', () => {
    const events = playOne(TEST_CONFIG, [
      fill('base', THREE_CORES),
      ...deadSpins(2),
      fill('free', [...BACKGROUND.slice(0, 6), '*****RQ']), // пять ядер — всё равно +5
      ...deadSpins(11),
      fill('free', THREE_CORES), // фриспин 15 из 15
      ...deadSpins(5),
    ]);

    expect(events.filter((event) => ['scatters', 'fsStart', 'fsSpin', 'fsRetrigger'].includes(event.t))).toStrictEqual([
      { t: 'scatters', cells: [42, 45, 48] },
      { t: 'fsStart', spins: 10 },
      { t: 'fsSpin', index: 1, left: 9 },
      { t: 'fsSpin', index: 2, left: 8 },
      { t: 'fsSpin', index: 3, left: 7 },
      { t: 'scatters', cells: [42, 43, 44, 45, 46] },
      { t: 'fsRetrigger', add: 5 },
      { t: 'fsSpin', index: 4, left: 11 },
      { t: 'fsSpin', index: 5, left: 10 },
      { t: 'fsSpin', index: 6, left: 9 },
      { t: 'fsSpin', index: 7, left: 8 },
      { t: 'fsSpin', index: 8, left: 7 },
      { t: 'fsSpin', index: 9, left: 6 },
      { t: 'fsSpin', index: 10, left: 5 },
      { t: 'fsSpin', index: 11, left: 4 },
      { t: 'fsSpin', index: 12, left: 3 },
      { t: 'fsSpin', index: 13, left: 2 },
      { t: 'fsSpin', index: 14, left: 1 },
      { t: 'fsSpin', index: 15, left: 0 },
      { t: 'scatters', cells: [42, 45, 48] },
      { t: 'fsRetrigger', add: 5 },
      { t: 'fsSpin', index: 16, left: 4 },
      { t: 'fsSpin', index: 17, left: 3 },
      { t: 'fsSpin', index: 18, left: 2 },
      { t: 'fsSpin', index: 19, left: 1 },
      { t: 'fsSpin', index: 20, left: 0 },
    ]);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 0 }]);
  });
});

describe('кап', () => {
  it('на втором фриспине: выигрыш обрезан до капа, дальше ни шага, остальные фриспины сгорают', () => {
    // Кап 1.5× ставки. Фриспин 1 даёт 1×, фриспин 2 — ещё 1×: сумма 2× обрезается до 1.5×.
    const events = playOne(withCap(150), [
      fill('base', [
        'QACESRQ',
        'CESRQAC',
        'SRQACES',
        'QACESRQ',
        'CESRQAC',
        'SRQACES',
        '*AC*SR*',
      ]),
      fill('free', [
        'QACESRQ',
        'CESRQAC',
        'SRQDCES',
        'QACDSRQ',
        'CESDQAC',
        'SRQDCES',
        'QACDSRQ',
      ]),
      drops('free', [
        '...R...',
        '...A...',
        '...E...',
        '...R...',
        '...A...',
        '.......',
        '.......',
      ]),
      fill('free', [
        'QACESRQ',
        'CESRQAC',
        'SRQDCES',
        'QACDSRQ',
        'CESDQAC',
        'SRQDCES',
        'QACDSRQ',
      ]),
      // Дальше сценария нет: любой запрос к источнику после капа уронил бы тест.
    ]);

    expect(events).toStrictEqual([
      {
        t: 'fill',
        grid: [
          0, 1, 2, 3, 4, 5, 0,
          2, 3, 4, 5, 0, 1, 2,
          4, 5, 0, 1, 2, 3, 4,
          0, 1, 2, 3, 4, 5, 0,
          2, 3, 4, 5, 0, 1, 2,
          4, 5, 0, 1, 2, 3, 4,
          7, 1, 2, 7, 4, 5, 7,
        ],
      },
      { t: 'scatters', cells: [42, 45, 48] },
      { t: 'fsStart', spins: 10 },
      { t: 'fsSpin', index: 1, left: 9 },
      {
        t: 'fill',
        grid: [
          0, 1, 2, 3, 4, 5, 0,
          2, 3, 4, 5, 0, 1, 2,
          4, 5, 0, 6, 2, 3, 4,
          0, 1, 2, 6, 4, 5, 0,
          2, 3, 4, 6, 0, 1, 2,
          4, 5, 0, 6, 2, 3, 4,
          0, 1, 2, 6, 4, 5, 0,
        ],
      },
      { t: 'win', clusters: [{ symbol: 6, cells: [17, 24, 31, 38, 45], payX100: 100, mult: 1 }] },
      { t: 'explode', cells: [17, 24, 31, 38, 45] },
      { t: 'spots', cells: [17, 24, 31, 38, 45], levels: [1, 1, 1, 1, 1] },
      {
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
      },
      { t: 'fsSpin', index: 2, left: 8 },
      {
        t: 'fill',
        grid: [
          0, 1, 2, 3, 4, 5, 0,
          2, 3, 4, 5, 0, 1, 2,
          4, 5, 0, 6, 2, 3, 4,
          0, 1, 2, 6, 4, 5, 0,
          2, 3, 4, 6, 0, 1, 2,
          4, 5, 0, 6, 2, 3, 4,
          0, 1, 2, 6, 4, 5, 0,
        ],
      },
      { t: 'win', clusters: [{ symbol: 6, cells: [17, 24, 31, 38, 45], payX100: 100, mult: 1 }] },
      { t: 'cap' },
      { t: 'end', payX100: 150 },
    ]);
  });

  it('ровно на капе в основном спине: кап, и фича не открывается, хотя ядер три', () => {
    const base = ['*ACESR*', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSR*'];
    const events = playOne(withCap(100), [fill('base', base)]);

    expect(events).toStrictEqual([
      { t: 'fill', grid: grid(base) },
      { t: 'win', clusters: [{ symbol: 6, cells: [17, 24, 31, 38, 45], payX100: 100, mult: 1 }] },
      { t: 'cap' },
      { t: 'end', payX100: 100 },
    ]);
  });

  it('на шаге каскада: до капа шаги идут, шаг через кап обрезан, итоговая сетка полная', () => {
    // Кап 3×: шаги 1 и 2 колонки дают 2.5× и 1×, второй шаг переходит кап.
    const events = playOne(withCap(300), [
      fill('base', ['QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ']),
      drops('base', ['...E...', '...R...', '...D...', '...D...', '...D...', '...D...', '...D...']),
    ]);

    expect(types(events)).toStrictEqual(['fill', 'win', 'explode', 'spots', 'refill', 'win', 'cap', 'end']);
    expect(only(events, 'end')).toStrictEqual([{ t: 'end', payX100: 300 }]);
    expect(gridsAfterSteps(events).at(-1)).toStrictEqual(['QACESRQ', 'CESRQAC', 'SRQDCES', 'QACDSRQ', 'CESDQAC', 'SRQDCES', 'QACDSRQ']);
  });
});
