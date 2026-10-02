// Ключи IndexedDB по возрастанию (§6.6) — одна таблица на два теста: Node сверяет с ней хранилище в памяти,
// e2e шага В — настоящую IndexedDB в браузере. Описания — простые данные: ключ из описания строит buildKey, и в Node,
// и на странице (функция без внешних ссылок — её можно передать в page.evaluate). Порядок снят пробой в Chrome for
// Testing 153.0.8010.12: числа < даты < строки < двоичные < массивы.

export type KeySpec =
  | { readonly number: number }
  | { readonly date: number }
  | { readonly string: string }
  /** Двоичный ключ; как его передать — ArrayBuffer, Uint8Array или DataView: курсор вернёт ArrayBuffer. */
  | { readonly binary: readonly number[]; readonly as: 'buffer' | 'uint8' | 'dataview' }
  | { readonly array: readonly KeySpec[] };

export const ORDERED_KEYS: readonly KeySpec[] = [
  { number: Number.NEGATIVE_INFINITY },
  { number: -1e300 },
  { number: -1 },
  { number: 0 },
  { number: 0.5 },
  { number: 1 },
  { number: 1.0000000000000004 },
  { number: 6 },
  { number: 7.5 },
  { number: 2 ** 51 },
  { number: 2 ** 52 },
  { number: 2 ** 53 },
  { number: 1e300 },
  { number: Number.POSITIVE_INFINITY },
  { date: -1 },
  { date: 0 },
  { date: 8.64e15 },
  { string: '' },
  { string: '0' },
  { string: 'A' },
  { string: 'a' },
  { string: 'ab' },
  { string: '\uD800' },
  { string: '😀' },
  { string: '￿' },
  { binary: [], as: 'buffer' },
  { binary: [0], as: 'uint8' },
  { binary: [0, 0], as: 'dataview' },
  { binary: [1], as: 'buffer' },
  { binary: [255], as: 'uint8' },
  { array: [] },
  { array: [{ number: 0 }] },
  { array: [{ number: 0 }, { number: 0 }] },
  { array: [{ date: 0 }] },
  { array: [{ string: '' }] },
  { array: [{ binary: [0], as: 'buffer' }] },
  { array: [{ array: [] }] },
];

/** Значения, которые ключом не являются: запись с таким seq хранится, но в индексе её нет. */
export const NON_KEYS = [
  'NaN',
  'invalid date',
  'true',
  'null',
  'undefined',
  'object',
  'bigint',
  'sparse array',
  'hole over prototype',
  'array with NaN',
  'array with object',
  'cyclic array',
  'number object',
  'boolean object',
] as const;

export type NonKey = (typeof NON_KEYS)[number];

/** Ключ из описания. Без ссылок наружу: строит ключ и в Node, и на странице. */
export function buildKey(spec: KeySpec): unknown {
  if ('number' in spec) return spec.number;
  if ('date' in spec) return new Date(spec.date);
  if ('string' in spec) return spec.string;
  if ('array' in spec) return spec.array.map((item) => buildKey(item));
  const bytes = new Uint8Array(spec.binary);
  if (spec.as === 'buffer') return bytes.buffer;
  return spec.as === 'uint8' ? bytes : new DataView(bytes.buffer);
}

/** Не-ключ по имени. Без ссылок наружу, как buildKey. */
export function buildNonKey(name: NonKey): unknown {
  switch (name) {
    case 'NaN':
      return Number.NaN;
    case 'invalid date':
      return new Date(Number.NaN);
    case 'true':
      return true;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'object':
      return { seq: 1 };
    case 'bigint':
      return 1n;
    case 'sparse array': {
      const sparse: number[] = [];
      sparse[1] = 1;
      return sparse;
    }
    case 'hole over prototype': {
      // Дыра не читается из прототипа: ключ — только собственные элементы (Chrome 153 — DataError, как в спецификации).
      const holed: number[] = [];
      holed[1] = 1;
      Object.setPrototypeOf(holed, Object.assign(Object.create(Array.prototype) as object, { 0: 5 }));
      return holed;
    }
    case 'array with NaN':
      return [1, Number.NaN];
    case 'array with object':
      return [1, {}];
    case 'cyclic array': {
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);
      return cyclic;
    }
    // Обёртки примитивов — объекты, а не числа и не даты: ключом не становятся, хотя Number() даёт число.
    case 'number object':
      return Object(5) as unknown;
    case 'boolean object':
      return Object(true) as unknown;
  }
}

/** Ключ, отданный хранилищем, обратно в описание: сравнивать можно toStrictEqual, двоичные — как числа байтов. */
export function describeKey(key: unknown): KeySpec | string {
  if (typeof key === 'number') return { number: key };
  if (typeof key === 'string') return { string: key };
  if (key instanceof Date) return { date: key.getTime() };
  if (key instanceof ArrayBuffer) return { binary: [...new Uint8Array(key)], as: 'buffer' };
  if (Array.isArray(key)) {
    const items: readonly unknown[] = key;
    return { array: items.map((item) => describeKey(item) as KeySpec) };
  }
  return `не ключ из курсора: ${Object.prototype.toString.call(key)}`;
}

/** Описание в том виде, в каком ключ вернёт курсор: двоичные — всегда ArrayBuffer. */
export function returnedSpec(spec: KeySpec): KeySpec {
  if ('binary' in spec) return { binary: spec.binary, as: 'buffer' };
  if ('array' in spec) return { array: spec.array.map(returnedSpec) };
  return spec;
}
