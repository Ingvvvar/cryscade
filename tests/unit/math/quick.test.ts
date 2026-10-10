import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { quickSum } from '../../../tools/math/quick-sum.ts';

// «Золотая» сумма §15: 2·10⁵ раундов конфига игры на сидах [0, 2·10⁵). Меняется при любом изменении движка
// или конфига — обновлять осознанно, в коммите объяснить почему. Тот же расчёт — `npm run math:quick`.
// 2·10⁵ раундов — 2.3–2.7 с в полном прогоне на M4, под 30 занятыми процессами — 7.3 с: свой предел, как у round-usage.
it('золотая сумма выплат и число выигрышей на 2·10⁵ раундов конфига игры', { timeout: 30_000 }, () => {
  expect(quickSum(DEFAULT_CONFIG)).toStrictEqual({ payX100: 18_014_290, wins: 60_127 });
});
