import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/core/model/config.ts';
import { quickSum } from '../../../tools/math/quick-sum.ts';

// «Золотая» сумма §15: 2·10⁵ раундов конфига игры на сидах [0, 2·10⁵). Меняется при любом изменении движка
// или конфига — обновлять осознанно, в коммите объяснить почему. Тот же расчёт — `npm run math:quick`.
it('золотая сумма выплат и число выигрышей на 2·10⁵ раундов конфига игры', () => {
  expect(quickSum(DEFAULT_CONFIG)).toStrictEqual({ payX100: 17_677_305, wins: 60_125 });
});
