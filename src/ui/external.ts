// Внешнее хранилище для React (§11): снимок через useSyncExternalStore. Подписка и снимок — стабильные функции на
// хранилище, иначе React переподписывался бы на каждом рендере.

import { useCallback, useSyncExternalStore } from 'react';

export interface ExternalSource<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export function useExternal<T>(source: ExternalSource<T>): T {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const snapshot = useCallback(() => source.getSnapshot(), [source]);
  return useSyncExternalStore(subscribe, snapshot);
}
