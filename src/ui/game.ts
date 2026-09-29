// Игра для React (§11): снимок контроллера через useSyncExternalStore и действия игрока. Настоящая — GameController
// из корня композиции; компоненты знают только этот интерфейс.

import { useCallback, useSyncExternalStore } from 'react';
import type { ControllerSnapshot } from '../client/index.ts';

export interface Game {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ControllerSnapshot;
  spin(): void;
  betUp(): void;
  betDown(): void;
  retry(): void;
  takeOver(): void;
  refill(): void;
}

export function useGameSnapshot(game: Game): ControllerSnapshot {
  const subscribe = useCallback((listener: () => void) => game.subscribe(listener), [game]);
  const snapshot = useCallback(() => game.getSnapshot(), [game]);
  return useSyncExternalStore(subscribe, snapshot);
}
