// Быстрая проверка: node tools/math/quick.ts — 2·10⁵ раундов конфига игры на сидах [0, 2·10⁵) в одном потоке
// и «золотая» сумма выплат в целых. Любое изменение движка или конфига меняет её: обновлять осознанно,
// в коммите — что изменилось и почему это правильно.
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { QUICK_ROUNDS, quickSum } from './quick-sum.ts';

const EXPECTED = { payX100: 18_003_530, wins: 60_127 };

const actual = quickSum(DEFAULT_CONFIG);
console.log(
  `${QUICK_ROUNDS.toLocaleString('ru-RU')} раундов: сумма выплат ${String(actual.payX100)} (RTP ${(actual.payX100 / QUICK_ROUNDS).toFixed(2)}%), выигрышей ${String(actual.wins)}`,
);
if (actual.payX100 !== EXPECTED.payX100 || actual.wins !== EXPECTED.wins) {
  console.log(`Золотая сумма изменилась: ожидалось ${String(EXPECTED.payX100)} и ${String(EXPECTED.wins)}. Обновить осознанно.`);
  process.exitCode = 1;
}
