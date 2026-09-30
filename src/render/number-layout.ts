// Разбор числа в символы для счётчиков Pixi (§10): целой арифметикой в предвыделенный буфер кодов — ни строки, ни
// объекта на кадр. Разделители и порог группировки приходят из ui (MoneyFormat): в render/ формата нет. Сумма — как у
// MoneyFormat: целая часть и копейки считаются целыми, без деления с плавающей точкой.

export interface NumberStyle {
  /** Разделитель разрядов — один символ (uk-UA — неразрывный пробел). */
  readonly group: string;
  /** Дробный разделитель — один символ. */
  readonly decimal: string;
  /** Наименьшая целая часть, которую делят на разряды: 1000, у локалей с минимумом группировки 2 — 10 000. */
  readonly groupFrom: number;
}

/** Длиннейшая сумма — 2^53 − 1 минимальных единиц: 14 цифр целой части, 4 разделителя разрядов, дробный и 2 цифры. */
export const MAX_GLYPHS = 24;

const ZERO = 48;

function codeOf(separator: string, name: string): number {
  if (separator.length !== 1) throw new RangeError(`${name}: ожидался один символ, получено «${separator}»`);
  return separator.charCodeAt(0);
}

/** Коды разделителей — один раз, при установке стиля: в кадре строки не читаются. */
export interface NumberCodes {
  readonly group: number;
  readonly decimal: number;
  readonly groupFrom: number;
}

export function numberCodes(style: NumberStyle): NumberCodes {
  if (!Number.isSafeInteger(style.groupFrom) || style.groupFrom < 1) throw new RangeError(`порог группировки — натуральное: ${String(style.groupFrom)}`);
  return { group: codeOf(style.group, 'разделитель разрядов'), decimal: codeOf(style.decimal, 'дробный разделитель'), groupFrom: style.groupFrom };
}

/** Переворот out[0, length) на месте. */
function reverse(out: Uint16Array, length: number): void {
  for (let a = 0, b = length - 1; a < b; a++, b--) {
    const swap = out[a] ?? 0;
    out[a] = out[b] ?? 0;
    out[b] = swap;
  }
}

/** Цифры целого value справа налево с разделителями разрядов; возвращает новую длину. */
function wholeDigits(value: number, codes: NumberCodes, out: Uint16Array, from: number): number {
  let n = from;
  let rest = value;
  const grouped = value >= codes.groupFrom;
  let digits = 0;
  do {
    if (grouped && digits > 0 && digits % 3 === 0) out[n++] = codes.group;
    out[n++] = ZERO + (rest % 10);
    rest = Math.floor(rest / 10);
    digits += 1;
  } while (rest > 0);
  return n;
}

/** Сумма minor минимальных единиц в коды символов out слева направо: «1 234,56». Возвращает число символов. */
export function layoutMoney(minor: number, codes: NumberCodes, out: Uint16Array): number {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`сумма — неотрицательное безопасное целое: ${String(minor)}`);
  const cents = minor % 100;
  let n = 0;
  out[n++] = ZERO + (cents % 10);
  out[n++] = ZERO + Math.floor(cents / 10);
  out[n++] = codes.decimal;
  n = wholeDigits((minor - cents) / 100, codes, out, n);
  reverse(out, n);
  return n;
}

/** Целое value с необязательной приставкой (код символа, −1 — без неё): «+5», «×128». Без разделителей разрядов. */
export function layoutInteger(value: number, prefix: number, out: Uint16Array): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`число — неотрицательное безопасное целое: ${String(value)}`);
  let n = 0;
  let rest = value;
  do {
    out[n++] = ZERO + (rest % 10);
    rest = Math.floor(rest / 10);
  } while (rest > 0);
  if (prefix >= 0) out[n++] = prefix;
  reverse(out, n);
  return n;
}
