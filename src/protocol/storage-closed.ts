import { PROTOCOL_VERSION } from './envelope.ts';
import { isRecord } from './guards.ts';

// Сообщение воркера своей странице, без запроса (§6.6): хранилище закрыто — другая вкладка открыла базу новой версии
// (versionchange). Воркер закрыл соединение, чтобы не держать обновление, и больше не пишет: игроку — перезагрузить.

export interface StorageClosed {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: 'storageClosed';
  readonly reason: 'versionchange';
}

/** Клиент: сообщение воркера без id. Чужая версия или мусор — не наше сообщение. Не бросает. */
export function checkStorageClosed(value: unknown): string | null {
  if (!isRecord(value)) return 'сообщение — не объект';
  if (value['v'] !== PROTOCOL_VERSION || value['type'] !== 'storageClosed') return 'сообщение — не storageClosed v1';
  return value['reason'] === 'versionchange' ? null : 'storageClosed: неизвестная причина';
}
