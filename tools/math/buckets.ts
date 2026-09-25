// Корзины по выплате §5, в ставках: 0; (0, 1]; (1, 2); [2, 5); … ; [2500, 5000); кап. Граница по 1× точная:
// выигрыш ровно в ставку — в (0, 1], поэтому «больше ставки» — это корзины от (1, 2) и выше.
// Общие для отчёта фазы 2 и книги фазы 6: прогноз и книга обязаны совпадать по корзинам.

export interface Bucket {
  readonly label: string;
  /** Входит ли выплата в сотых долях ставки. Кап — своя корзина, в диапазоны не входит. */
  readonly holds: (payX100: number, capX100: number) => boolean;
}

function range(label: string, fromX100: number, toX100: number): Bucket {
  return { label, holds: (pay, cap) => pay !== cap && pay >= fromX100 && pay < toX100 };
}

export const BUCKETS: readonly Bucket[] = [
  { label: '0', holds: (pay) => pay === 0 },
  { label: '(0, 1]', holds: (pay, cap) => pay !== cap && pay > 0 && pay <= 100 },
  { label: '(1, 2)', holds: (pay, cap) => pay !== cap && pay > 100 && pay < 200 },
  range('[2, 5)', 200, 500),
  range('[5, 10)', 500, 1000),
  range('[10, 20)', 1000, 2000),
  range('[20, 50)', 2000, 5000),
  range('[50, 100)', 5000, 10_000),
  range('[100, 250)', 10_000, 25_000),
  range('[250, 500)', 25_000, 50_000),
  range('[500, 1000)', 50_000, 100_000),
  range('[1000, 2500)', 100_000, 250_000),
  range('[2500, 5000)', 250_000, 500_000),
  { label: 'кап', holds: (pay, cap) => pay === cap },
];

export function bucketOf(payX100: number, capX100: number): number {
  const index = BUCKETS.findIndex((bucket) => bucket.holds(payX100, capX100));
  if (index < 0) throw new RangeError(`выплата ${String(payX100)} вне корзин при капе ${String(capX100)}`);
  return index;
}
