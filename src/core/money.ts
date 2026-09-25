// Деньги §4.6: целые минимальные единицы — сотые кредита. Ни одного float в балансе и выплатах.

export const MINOR_PER_CREDIT = 100;

/** Ставки 0.20, 0.40, 1, 2, 4, 10, 20, 50, 100 кредитов. */
export const BET_LEVELS_MINOR: readonly number[] = [20, 40, 100, 200, 400, 1000, 2000, 5000, 10000];

/** Стартовый баланс и баланс после «Пополнить» — 1000 кредитов. */
export const START_BALANCE_MINOR = 100_000;

export function isBetLevel(betMinor: number): boolean {
  return BET_LEVELS_MINOR.includes(betMinor);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}: ожидается неотрицательное целое, получено ${String(value)}`);
  }
}

/**
 * Выигрыш раунда = floor(bet × payX100 / 100): одно округление в конце раунда, вниз.
 * payX100 — сотые доли ставки. Считается целыми: произведение точное, остаток отбрасывается.
 */
export function winMinor(betMinor: number, payX100: number): number {
  assertNonNegativeSafeInteger(betMinor, 'betMinor');
  assertNonNegativeSafeInteger(payX100, 'payX100');
  const product = betMinor * payX100;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`betMinor × payX100 вне 2^53: ${String(betMinor)} × ${String(payX100)}`);
  }
  return (product - (product % 100)) / 100;
}
