// Клиент (§6.5): контроллер, RgsClient, лаборатория сети, порты и их адаптеры — в памяти и браузерные.
export {
  GameController,
  type ClientNotice,
  type ControllerSnapshot,
  type ReplayTarget,
  type SettledRound,
} from './game-controller.ts';
export { MemoryRoundLock } from './memory-round-lock.ts';
export { CLEAR_NETWORK, NetworkLabTransport, type LabSettings } from './network-lab.ts';
export {
  Presenter,
  type CheckpointStore,
  type ClockListener,
  type Presentation,
  type PresentationListener,
  type PresentationSettings,
} from './presenter.ts';
export { CHECKPOINT_KEY, SessionCheckpoint, type KeyValueStore } from './session-checkpoint.ts';
export type { KeySource, RoundLease, RoundLock, TabChannel, Transport } from './ports.ts';
export { RgsClient, type CallOutcome, type Rgs } from './rgs-client.ts';
export { TimeoutSleep } from './timeout-sleep.ts';
export { WalletBook, type WalletUpdate } from './wallet-book.ts';
export { BroadcastTabChannel } from './broadcast-tab-channel.ts';
export { UuidKeys } from './uuid-keys.ts';
export { WebRoundLock, type LockRequests } from './web-round-lock.ts';
export { WorkerTransport, type WorkerLike } from './worker-transport.ts';
// Типы машины состояний, которые видит ui/: вид состояния и виды ошибок — через клиента, не напрямую из core/fsm.
export type { ErrorKind, ShownRound } from '../core/fsm/index.ts';
// Пресеты юрисдикции (§11) и параметры расписания — ui выбирает их через клиента, core/ ему не виден.
export { PRESETS, type PresetFlags, type PresetName } from '../core/jurisdiction.ts';
export type { ScheduleOptions } from '../core/presentation/index.ts';
