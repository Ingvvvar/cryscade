// Клиент (§6.5): контроллер, RgsClient, лаборатория сети, порты и их адаптеры — в памяти и браузерные.
export { GameController, type ClientNotice, type ControllerSnapshot, type GameControllerPorts } from './game-controller.ts';
export { MemoryRoundLock } from './memory-round-lock.ts';
export { CLEAR_NETWORK, NetworkLabTransport, type LabSettings, type NetworkLabOptions } from './network-lab.ts';
export { Presenter, type Presentation, type PresentationSettings } from './presenter.ts';
export type { KeySource, RoundLease, RoundLock, Sleep, TabChannel, Transport } from './ports.ts';
export { ATTEMPT_TIMEOUT_MS, RETRY_DELAYS_MS, RgsClient, type CallOutcome, type Rgs, type RgsClientOptions } from './rgs-client.ts';
export { TimeoutSleep } from './timeout-sleep.ts';
export { WalletBook, type WalletUpdate } from './wallet-book.ts';
export { BroadcastTabChannel } from './broadcast-tab-channel.ts';
export { UuidKeys } from './uuid-keys.ts';
export { ROUND_LOCK, WebRoundLock, type LockRequests } from './web-round-lock.ts';
export { WorkerTransport, type WorkerLike } from './worker-transport.ts';
// Типы машины состояний, которые видит ui/: вид состояния и виды ошибок — через клиента, не напрямую из core/fsm.
export type { ErrorKind, ShownRound, StateView } from '../core/fsm/index.ts';
// Пресеты юрисдикции (§11) — ui выбирает пресет показа через клиента, core/ ему не виден.
export { PRESETS, type PresetFlags } from '../core/jurisdiction.ts';
