// Клиент (§6.5): контроллер, RgsClient, лаборатория сети, порты и их адаптеры без браузера.
export { GameController, type ControllerSnapshot, type GameControllerPorts } from './game-controller.ts';
export { MemoryRoundLock } from './memory-round-lock.ts';
export { CLEAR_NETWORK, NetworkLabTransport, type LabSettings, type NetworkLabOptions } from './network-lab.ts';
export type { KeySource, RoundLease, RoundLock, Sleep, TabChannel, Transport } from './ports.ts';
export { ATTEMPT_TIMEOUT_MS, RETRY_DELAYS_MS, RgsClient, type CallOutcome, type Rgs, type RgsClientOptions } from './rgs-client.ts';
export { TimeoutSleep } from './timeout-sleep.ts';
export { WalletBook, type WalletUpdate } from './wallet-book.ts';
