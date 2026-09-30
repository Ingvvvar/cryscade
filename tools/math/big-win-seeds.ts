// Сиды принудительных раундов для уровней большого выигрыша (фаза 5): node tools/math/big-win-seeds.ts
// Первый по возрастанию от 0 сид, чей раунд дал уровень 1 (от 20×), 2 (от 50×), 3 (от 100×, без капа) на итоговом
// конфиге игры. Сиды уходят литералами в src/ui/forced-rounds.ts; тест сверяет их уровни движком заново.
import { EventRecorder, SeededEngine } from '../../src/core/engine/index.ts';
import { DEFAULT_CONFIG } from '../../src/core/model/config.ts';
import { bigWinLevel } from '../../src/core/presentation/index.ts';
import { SIMULATOR_MAX_REQUESTS } from './limits.ts';

const SEARCH_LIMIT = 10_000_000;
const engine = new SeededEngine(DEFAULT_CONFIG, new EventRecorder(), { maxRequests: SIMULATOR_MAX_REQUESTS });
const found = new Map<number, { readonly seed: number; readonly payX100: number }>();
for (let seed = 0; seed < SEARCH_LIMIT && found.size < 3; seed++) {
  const payX100 = engine.play(seed);
  const level = bigWinLevel(payX100, payX100 >= DEFAULT_CONFIG.capX100);
  if (level >= 1 && level <= 3 && !found.has(level)) found.set(level, { seed, payX100 });
}
for (const level of [1, 2, 3]) {
  const hit = found.get(level);
  if (hit === undefined) throw new Error(`уровень ${String(level)} не найден на ${String(SEARCH_LIMIT)} сидах`);
  console.log(`уровень ${String(level)}: сид ${String(hit.seed)}, ${(hit.payX100 / 100).toFixed(2)}×`);
}
