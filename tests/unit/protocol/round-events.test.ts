import { describe, expect, it } from 'vitest';
import { checkRoundEvents, isRoundEvents, isSymbolGrid } from '../../../src/protocol/index.ts';
import { FIXTURE_NAMES, fixtureRound, type FixtureName } from '../../support/fixture-rounds.ts';

// Гард событий раунда (§4.8): все фикстуры проходят, а каждое правило — своя литеральная поломка записанного раунда
// с точным текстом проблемы. Точный текст держит правило поштучно: выключенное правило даёт другой ответ.

type Loose = { [key: string]: unknown };
type Edit = (events: unknown[]) => void;

const obj = (value: unknown): Loose => value as Loose;
const arr = (value: unknown): unknown[] => value as unknown[];
const ev = (events: unknown[], index: number): Loose => obj(events[index]);
const cluster = (events: unknown[], index: number, at = 0): Loose => obj(arr(ev(events, index)['clusters'])[at]);

function broken(name: FixtureName, edit: Edit): unknown[] {
  const events = structuredClone(fixtureRound(name).events) as unknown[];
  edit(events);
  return events;
}

describe('isSymbolGrid', () => {
  it('49 целых от 0 до 7', () => {
    expect(isSymbolGrid(new Array<number>(49).fill(7))).toBe(true);
    expect(isSymbolGrid(new Array<number>(48).fill(0))).toBe(false);
    expect(isSymbolGrid(new Array<number>(50).fill(0))).toBe(false);
    expect(isSymbolGrid([...new Array<number>(48).fill(0), 8])).toBe(false);
    expect(isSymbolGrid([...new Array<number>(48).fill(0), -1])).toBe(false);
    expect(isSymbolGrid([...new Array<number>(48).fill(0), 0.5])).toBe(false);
    expect(isSymbolGrid([...new Array<number>(48).fill(0), '0'])).toBe(false);
    expect(isSymbolGrid('0'.repeat(49))).toBe(false);
  });
});

describe('checkRoundEvents: записанные раунды проходят', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { events } = fixtureRound(name);
    expect(checkRoundEvents(events)).toBeNull();
    expect(isRoundEvents(events)).toBe(true);
  });
});

// [раунд, поломка, точный ответ гарда]
const SHAPE: [FixtureName, string, Edit, string][] = [
  ['small-win', 'событие — null', (e) => (e[1] = null), 'событие 1: событие — не объект'],
  ['small-win', 'fill из 48 символов', (e) => (ev(e, 0)['grid'] = arr(ev(e, 0)['grid']).slice(0, 48)), 'событие 0: fill: нужны 49 символов'],
  ['small-win', 'fill с символом 8', (e) => (arr(ev(e, 0)['grid'])[0] = 8), 'событие 0: fill: нужны 49 символов'],
  ['small-win', 'fill с дробным символом', (e) => (arr(ev(e, 0)['grid'])[0] = 1.5), 'событие 0: fill: нужны 49 символов'],
  ['small-win', 'win без кластеров', (e) => (ev(e, 1)['clusters'] = []), 'событие 1: win без кластеров'],
  ['small-win', 'кластер — строка', (e) => (arr(ev(e, 1)['clusters'])[0] = 'кластер'), 'событие 1: win: кластер — не объект'],
  ['small-win', 'кластер на ядре', (e) => (cluster(e, 1)['symbol'] = 7), 'событие 1: win: symbol кластера — не платящий символ'],
  ['small-win', 'клетки кластера вразнобой', (e) => (cluster(e, 1)['cells'] = [10, 8, 15, 16, 17]), 'событие 1: win: клетки кластера — не клетки по возрастанию'],
  ['small-win', 'кластер без клеток', (e) => (cluster(e, 1)['cells'] = []), 'событие 1: win: клетки кластера — не клетки по возрастанию'],
  ['small-win', 'mult 0', (e) => (cluster(e, 1)['mult'] = 0), 'событие 1: win: payX100 или mult кластера — не целые'],
  ['small-win', 'выплата кластера отрицательная', (e) => (cluster(e, 1)['payX100'] = -35), 'событие 1: win: payX100 или mult кластера — не целые'],
  ['small-win', '35 не делится на mult 2', (e) => (cluster(e, 1)['mult'] = 2), 'событие 1: win: payX100 кластера не делится на mult'],
  ['small-win', 'explode вразнобой', (e) => (ev(e, 2)['cells'] = [17, 16, 15, 10, 8]), 'событие 2: explode: клетки не по возрастанию'],
  ['small-win', 'уровней меньше клеток', (e) => (ev(e, 3)['levels'] = [1, 1, 1, 1]), 'событие 3: spots: клетки и уровни не парами'],
  ['small-win', 'уровень 9', (e) => (arr(ev(e, 3)['levels'])[0] = 9), 'событие 3: spots: уровень вне 1…8'],
  ['small-win', 'уровень 0', (e) => (arr(ev(e, 3)['levels'])[0] = 0), 'событие 3: spots: уровень вне 1…8'],
  ['small-win', 'refill без moves', (e) => delete ev(e, 4)['moves'], 'событие 4: refill без moves или drops'],
  ['small-win', 'сдвиг из одной клетки', (e) => (arr(ev(e, 4)['moves'])[0] = [1]), 'событие 4: сдвиг — не пара клеток'],
  ['small-win', 'сдвиг в клетку 49', (e) => (arr(ev(e, 4)['moves'])[0] = [1, 49]), 'событие 4: сдвиг — не пара клеток'],
  ['small-win', 'досыпка — число', (e) => (arr(ev(e, 4)['drops'])[0] = 5), 'событие 4: досыпка — не объект'],
  ['small-win', 'досыпан символ 8', (e) => (obj(arr(ev(e, 4)['drops'])[0])['symbol'] = 8), 'событие 4: досыпка — не клетка с символом'],
  [
    'small-win',
    'досыпка вразнобой',
    (e) => {
      const drops = arr(ev(e, 4)['drops']);
      [drops[0], drops[1]] = [drops[1], drops[0]];
    },
    'событие 4: досыпка не по возрастанию клетки',
  ],
  ['feature-start', 'scatters без клеток', (e) => (ev(e, 1)['cells'] = []), 'событие 1: scatters: клетки не по возрастанию'],
  ['feature-start', 'fsStart на 0 спинов', (e) => (ev(e, 2)['spins'] = 0), 'событие 2: fsStart: spins не положительное целое'],
  ['feature-start', 'fsSpin с номером 0', (e) => (ev(e, 3)['index'] = 0), 'событие 3: fsSpin: index или left не целые'],
  ['retrigger', 'ретриггер на 0 спинов', (e) => (ev(e, 34)['add'] = 0), 'событие 34: fsRetrigger: add не положительное целое'],
  ['small-win', 'end отрицательный', (e) => (ev(e, 5)['payX100'] = -1), 'событие 5: end: payX100 не целое'],
  ['small-win', 'неизвестное событие', (e) => (ev(e, 1)['t'] = 'boom'), 'событие 1: неизвестный тип события'],
];

const GRAMMAR: [FixtureName, string, Edit, string][] = [
  ['small-win', 'второй end', (e) => e.push({ t: 'end', payX100: 35 }), 'событие 6: событие после end'],
  ['small-win', 'fill вместо win', (e) => (e[1] = structuredClone(e[0])), 'событие 1: fill не на месте'],
  ['small-win', 'win дважды подряд', (e) => e.splice(2, 0, structuredClone(e[1])), 'событие 2: win не после сетки'],
  ['small-win', 'explode без win', (e) => e.splice(1, 1), 'событие 1: explode не после win'],
  ['small-win', 'spots без explode', (e) => e.splice(2, 1), 'событие 2: spots не после explode'],
  ['small-win', 'точка вне взрыва', (e) => (ev(e, 3)['cells'] = [8, 10, 15, 16, 18]), 'событие 3: spots: клетка вне взрыва'],
  ['small-win', 'refill без spots', (e) => e.splice(3, 1), 'событие 3: refill не после spots'],
  ['loss', 'cap без win', (e) => e.splice(1, 0, { t: 'cap' }), 'событие 1: cap не сразу после win'],
  ['small-win', 'scatters посреди шага', (e) => e.splice(2, 0, { t: 'scatters', cells: [2] }), 'событие 2: scatters не после сетки'],
  ['small-win', 'fsStart без scatters', (e) => e.splice(1, 0, { t: 'fsStart', spins: 10 }), 'событие 1: fsStart не после scatters основной игры'],
  ['feature-start', 'ретриггер в основной игре', (e) => (e[2] = { t: 'fsRetrigger', add: 5 }), 'событие 2: fsRetrigger не после scatters фриспина'],
  ['retrigger', 'счёт спинов за 2^53', (e) => (ev(e, 34)['add'] = Number.MAX_SAFE_INTEGER), 'событие 34: fsRetrigger: счёт спинов вне целых'],
  [
    'base-win',
    'кластеры не по наименьшей клетке',
    (e) => {
      const clusters = arr(ev(e, 1)['clusters']);
      [clusters[0], clusters[1]] = [clusters[1], clusters[0]];
    },
    'событие 1: win: кластеры не по наименьшей клетке',
  ],
  [
    'small-win',
    'кластеры пересекаются',
    (e) => arr(ev(e, 1)['clusters']).push({ symbol: 1, cells: [10], payX100: 0, mult: 1 }),
    'событие 1: win: кластеры пересекаются',
  ],
  ['small-win', 'кластер не на своём символе', (e) => (cluster(e, 1)['symbol'] = 2), 'событие 1: win: в клетке кластера другой символ'],
  ['cascade-3', 'сумма выплат за 2^53', (e) => (cluster(e, 1)['payX100'] = Number.MAX_SAFE_INTEGER), 'событие 5: win: сумма выплат вне целых'],
  ['small-win', 'взрыв вне кластера', (e) => (ev(e, 2)['cells'] = [8, 10, 15, 16, 18]), 'событие 2: explode: клетка вне кластеров win'],
  ['small-win', 'взрыв не всего кластера', (e) => (ev(e, 2)['cells'] = [8, 10, 15, 16]), 'событие 2: explode: не все клетки кластеров'],
  ['small-win', 'сдвиг в чужую колонку', (e) => (arr(ev(e, 4)['moves'])[0] = [1, 16]), 'событие 4: refill: сдвиг не вниз по своей колонке'],
  ['small-win', 'сдвиг вверх', (e) => (arr(ev(e, 4)['moves'])[0] = [15, 1]), 'событие 4: refill: сдвиг не вниз по своей колонке'],
  [
    'small-win',
    'колонки справа налево',
    (e) => (ev(e, 4)['moves'] = [[9, 16], [2, 9], [1, 15], [3, 17]]),
    'событие 4: refill: колонки не слева направо',
  ],
  [
    'small-win',
    'в колонке сверху вниз',
    (e) => (ev(e, 4)['moves'] = [[1, 15], [9, 16], [2, 16], [3, 17]]),
    'событие 4: refill: в колонке сдвиги не снизу вверх',
  ],
  ['small-win', 'сдвиг из пустой клетки', (e) => (arr(ev(e, 4)['moves'])[0] = [8, 15]), 'событие 4: refill: сдвиг из пустой клетки или в занятую'],
  ['small-win', 'сдвиг в занятую клетку', (e) => (arr(ev(e, 4)['moves'])[0] = [1, 22]), 'событие 4: refill: сдвиг из пустой клетки или в занятую'],
  ['small-win', 'досыпка в занятую вместо пустой', (e) => (obj(arr(ev(e, 4)['drops'])[0])['cell'] = 0), 'событие 4: refill: досыпка не ровно в пустые клетки'],
  ['small-win', 'лишняя досыпка', (e) => arr(ev(e, 4)['drops']).push({ cell: 11, symbol: 0 }), 'событие 4: refill: досыпка в занятую клетку'],
  ['feature-start', 'не все ядра', (e) => (ev(e, 1)['cells'] = [10, 21]), 'событие 1: scatters: не все ядра сетки'],
  ['small-win', 'fsSpin в основной игре', (e) => e.splice(5, 0, { t: 'fsSpin', index: 1, left: 0 }), 'событие 5: fsSpin не на месте'],
  ['feature-start', 'fsSpin не по номеру', (e) => (ev(e, 3)['index'] = 2), 'событие 3: fsSpin: номер или остаток не по счёту'],
  ['feature-start', 'fsSpin не по остатку', (e) => (ev(e, 3)['left'] = 8), 'событие 3: fsSpin: номер или остаток не по счёту'],
  ['small-win', 'end посреди шага', (e) => e.splice(4, 1), 'событие 4: end не на месте'],
  ['small-win', 'end не равен сумме', (e) => (ev(e, 5)['payX100'] = 96), 'событие 5: end: payX100 не сходится с суммой кластеров'],
  ['biggest', 'кап выше суммы', (e) => (ev(e, 97)['payX100'] = 1e12), 'событие 97: end: payX100 не сходится с суммой кластеров'],
  ['small-win', 'без end', (e) => e.pop(), 'раунд без end'],
];

describe('checkRoundEvents: строение события', () => {
  it.each(SHAPE)('%s: %s', (name, _what, edit, problem) => {
    expect(checkRoundEvents(broken(name, edit))).toBe(problem);
  });
});

describe('checkRoundEvents: грамматика и сквозная сверка сетки', () => {
  it.each(GRAMMAR)('%s: %s', (name, _what, edit, problem) => {
    expect(checkRoundEvents(broken(name, edit))).toBe(problem);
  });

  it('пусто и не массив', () => {
    expect(checkRoundEvents([])).toBe('события — не непустой массив');
    expect(checkRoundEvents('fill')).toBe('события — не непустой массив');
    expect(checkRoundEvents({ 0: { t: 'fill' } })).toBe('события — не непустой массив');
  });

  it('кап обрывает раунд: win cap end, end — не выше суммы', () => {
    const { events } = fixtureRound('biggest');
    expect(events.slice(-3).map((event) => event.t)).toStrictEqual(['win', 'cap', 'end']);
    expect(checkRoundEvents(events)).toBeNull();
  });
});
