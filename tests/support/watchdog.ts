import { SeededEngine, type RoundRecorder } from '../../src/core/engine/index.ts';
import type { GameConfig } from '../../src/core/model/config.ts';

/**
 * Порог сторожа в тестах — запросов к источнику за раунд; порог задаёт вызывающий, не движок (§4.7).
 * Самый длинный честный раунд: стресс-конфиг — 2017 на 10⁵ сидах, конфиг игры — 2166 на 10⁸, TEST_CONFIG с капом —
 * 23 909 на 200. Порог выше: срабатывает только на надкритичной фиче без капа или бесконечном каскаде — и за
 * миллисекунды, а не зависанием.
 */
export const WATCHDOG_LIMIT = 100_000;

/** Раунды по сиду под тестовым сторожем. */
export function guarded(config: GameConfig, recorder: RoundRecorder): SeededEngine {
  return new SeededEngine(config, recorder, { maxRequests: WATCHDOG_LIMIT });
}
