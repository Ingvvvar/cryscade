// Игра для React (§11): снимок контроллера через useSyncExternalStore и действия игрока. Настоящая — GameController
// из корня композиции; компоненты знают только этот интерфейс.

import { useCallback, useSyncExternalStore } from 'react';
import type { ControllerSnapshot, SettledRound } from '../client/index.ts';

export interface Game {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ControllerSnapshot;
  spin(): void;
  /** Тап по сцене, пробел или «Спін» во время показа: пропуск или «продолжить» на плашке фриспинов. */
  tap(): void;
  betUp(): void;
  betDown(): void;
  /** Ставка из списка уровней; вне покоя и не уровень — ничего. */
  setBet(betMinor: number): void;
  retry(): void;
  takeOver(): void;
  refill(): void;
  /** Раунды, закрытые этой вкладкой: итог для экранного диктора. */
  onRoundSettled(listener: (round: SettledRound) => void): () => void;
}

export function useGameSnapshot(game: Game): ControllerSnapshot {
  const subscribe = useCallback((listener: () => void) => game.subscribe(listener), [game]);
  const snapshot = useCallback(() => game.getSnapshot(), [game]);
  return useSyncExternalStore(subscribe, snapshot);
}
