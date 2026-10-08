// Протокол v1 между клиентом и сервером: конверт, сообщения, гарды (§6.1).
export {
  PROTOCOL_VERSION,
  parseRequest,
  parseResponse,
  requestEnvelope,
  responseEnvelope,
  type ResponseEnvelope,
} from './envelope.ts';
export { isAscendingInts, isClientSeed, isHex64, isIntIn, isNat, isPositive, isRecord, isToken } from './guards.ts';
export {
  BOOK_RECORDS_MAX,
  checkError,
  checkRequestBody,
  checkResult,
  checkRoundView,
  type AuthenticateResult,
  type BalanceResult,
  type ClientConfig,
  type ErrorCode,
  type FairnessView,
  type HistoryEntry,
  type HistoryResult,
  type LoadBookResult,
  type PlayResult,
  type ProtocolError,
  type ReplayResult,
  type RequestBody,
  type RequestType,
  type ResponseBody,
  type Results,
  type RoundOrigin,
  type RoundView,
  type SeedResult,
  type StorageNotice,
  type VerifyResult,
  type WalletView,
} from './messages.ts';
export { PROBE_CHANNEL, checkForceRound, checkForceRoundAck, checkMemoryLeak, type ForceRound, type ForceRoundAck, type MemoryLeak } from './probe-channel.ts';
export { checkRoundEvents, isRoundEvents, isSymbolGrid } from './round-events.ts';
export { checkStorageClosed, type StorageClosed } from './storage-closed.ts';
export { TAB_CHANNEL, checkWalletChanged, type WalletChanged } from './wallet-changed.ts';
