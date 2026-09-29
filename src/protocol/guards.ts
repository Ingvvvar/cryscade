// Кирпичи гардов. Всё, что пришло через границу — postMessage, IndexedDB, BroadcastChannel, — unknown,
// пока гард не сказал иначе. Гарды не бросают: на любом входе отвечают да или нет. Целое по смыслу поле — всегда
// безопасное целое плюс свои границы: дробное и 2^53 не проходят ни одно.

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Неотрицательное безопасное целое: деньги, выплаты, счётчики. */
export function isNat(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Положительное безопасное целое. */
export function isPositive(value: unknown): value is number {
  return isNat(value) && value > 0;
}

/** Безопасное целое от min до max включительно. */
export function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Строка-идентификатор: ключ идемпотентности, id раунда. От 1 до 64 знаков из [0-9A-Za-z_-]. */
export function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
}

/** Массив целых от min до max, строго по возрастанию. */
export function isAscendingInts(value: unknown, min: number, max: number): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  const items: readonly unknown[] = value;
  let previous = min - 1;
  for (const item of items) {
    if (!isIntIn(item, min, max) || item <= previous) return false;
    previous = item;
  }
  return true;
}
