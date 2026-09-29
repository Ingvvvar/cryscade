import { PROTOCOL_VERSION } from './envelope.ts';
import { isNat, isRecord, isToken } from './guards.ts';

// Оповещение остальных вкладок (§6.3): после каждой записи кошелька сервер шлёт его новое состояние в BroadcastChannel.
// revision растёт с каждой записью — по ней получатель отбрасывает запоздавшее. notice: 'reset' — запись была
// починкой испорченного хранилища, игроку показывается полоса.

/** Имя общего канала вкладок: в него пишет воркер каждой вкладки, его слушает каждая страница. */
export const TAB_CHANNEL = 'cryscade';

export interface WalletChanged {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: 'walletChanged';
  readonly balanceMinor: number;
  readonly activeRoundId: string | null;
  readonly revision: number;
  readonly notice: 'reset' | null;
}

/** Клиент: сообщение канала. Чужая версия или мусор — не наше сообщение. Не бросает. */
export function checkWalletChanged(value: unknown): string | null {
  if (!isRecord(value)) return 'оповещение — не объект';
  if (value['v'] !== PROTOCOL_VERSION || value['type'] !== 'walletChanged') return 'оповещение — не walletChanged v1';
  if (!isNat(value['balanceMinor']) || !isNat(value['revision'])) return 'оповещение: balanceMinor или revision — не целые';
  const active = value['activeRoundId'];
  if (active !== null && !isToken(active)) return 'оповещение: activeRoundId — не id';
  const notice = value['notice'];
  return notice === null || notice === 'reset' ? null : 'оповещение: неизвестное уведомление';
}
