// Протокол v1 между клиентом и сервером: конверт, сообщения, гарды (§6.1).
export {
  PROTOCOL_VERSION,
  parseRequest,
  parseResponse,
  requestEnvelope,
  responseEnvelope,
  type ParsedRequest,
  type ParsedResponse,
  type RequestEnvelope,
  type ResponseEnvelope,
} from './envelope.ts';
export { isAscendingInts, isIntIn, isNat, isPositive, isRecord, isToken } from './guards.ts';
export {
  checkError,
  checkRequestBody,
  checkResult,
  checkRoundView,
  type AuthenticateResult,
  type BalanceResult,
  type ClientConfig,
  type ErrorCode,
  type PlayResult,
  type ProtocolError,
  type RequestBody,
  type RequestType,
  type ResponseBody,
  type Results,
  type RoundView,
  type StorageNotice,
  type WalletView,
} from './messages.ts';
export { PROBE_CHANNEL, checkForceRound, checkForceRoundAck, type ForceRound, type ForceRoundAck } from './probe-channel.ts';
export { checkRoundEvents, isRoundEvents, isSymbolGrid } from './round-events.ts';
export { checkStorageClosed, type StorageClosed } from './storage-closed.ts';
export { TAB_CHANNEL, checkWalletChanged, type WalletChanged } from './wallet-changed.ts';
