import type { StoreKey } from './ports.ts';

// Ключи по правилам IndexedDB (§6.6) — для хранилища в памяти: что считается ключом, в каком виде ключ возвращается
// и как ключи сравниваются. Порядок типов: число < дата < строка < двоичные < массив; строки — по кодовым единицам,
// двоичные — побайтно, массивы — поэлементно, короче — раньше. Имени Date в server/ нет — это граница времени
// (скан глобалов), поэтому дата узнаётся по встроенному тегу.

const DATE_TAG = '[object Date]';

function isDateObject(value: object): boolean {
  return Object.prototype.toString.call(value) === DATE_TAG;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function convert(value: unknown, seen: Set<object>): StoreKey | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || seen.has(value)) return null;
  if (value instanceof ArrayBuffer) {
    return (value as { readonly detached?: boolean }).detached === true ? null : copyBytes(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) return copyBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) {
    // Цикл — не ключ; тот же массив дважды рядом — ключ: Chrome 153 следит только за предками (проба фазы 4).
    seen.add(value);
    const items: readonly unknown[] = value;
    const keys: StoreKey[] = [];
    for (let index = 0; index < items.length; index++) {
      if (!Object.hasOwn(items, index)) return null;
      const key = convert(items[index], seen);
      if (key === null) return null;
      keys.push(key);
    }
    seen.delete(value);
    return keys;
  }
  if (!isDateObject(value) || Number.isNaN(Number(value))) return null;
  return structuredClone(value) as StoreKey;
}

/**
 * Значение → ключ IndexedDB в том виде, в каком его отдаёт курсор: число, строка, копия даты, ArrayBuffer, массив.
 * Не ключ — null: NaN, неверная дата, boolean, null, объект, дырявый массив, массив с не-ключом, цикл.
 */
export function toKey(value: unknown): StoreKey | null {
  return convert(value, new Set());
}

/** 0 — число, 1 — дата, 2 — строка, 3 — двоичные, 4 — массив. */
function rank(key: StoreKey): number {
  if (typeof key === 'number') return 0;
  if (typeof key === 'string') return 2;
  if (Array.isArray(key)) return 4;
  return key instanceof ArrayBuffer || ArrayBuffer.isView(key) ? 3 : 1;
}

function bytesOf(key: StoreKey): Uint8Array | null {
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  return ArrayBuffer.isView(key) ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength) : null;
}

function compareValues(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Сравнение двух ключей IndexedDB: −1, 0 или 1. */
export function compareKeys(a: StoreKey, b: StoreKey): number {
  const order = rank(a) - rank(b);
  if (order !== 0) return order < 0 ? -1 : 1;
  if (typeof a === 'number' || typeof a === 'string') return compareValues(a, b as number | string);
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length);
    for (let index = 0; index < shared; index++) {
      const item = compareKeys(a[index] as StoreKey, b[index] as StoreKey);
      if (item !== 0) return item;
    }
    return compareValues(a.length, b.length);
  }
  const left = bytesOf(a);
  const right = bytesOf(b);
  if (left !== null && right !== null) {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index++) {
      const item = compareValues(left[index] ?? 0, right[index] ?? 0);
      if (item !== 0) return item;
    }
    return compareValues(left.length, right.length);
  }
  return compareValues(Number(a), Number(b));
}

/** Тождество ключа для карт: равные по compareKeys ключи дают одну строку, разные — разные. −0 и 0 — один ключ. */
export function keyId(key: StoreKey): string {
  if (typeof key === 'number') return `n${String(key)}`;
  if (typeof key === 'string') return `s${JSON.stringify(key)}`;
  if (Array.isArray(key)) return `a[${key.map((item: StoreKey) => keyId(item)).join(',')}]`;
  const bytes = bytesOf(key);
  if (bytes !== null) return `b${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return `d${String(Number(key))}`;
}
