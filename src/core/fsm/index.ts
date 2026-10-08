// Машина состояний клиента (§8.1): переходы и команды — данные, исполняет их контроллер.
export {
  AuthenticatingState,
  BootingState,
  EndingState,
  ErrorState,
  FeatureIntroState,
  IdleState,
  PresentingState,
  RefillingState,
  ReplayingState,
  RequestingState,
  RestoringState,
  WaitingForTabState,
  initialState,
} from './states.ts';
export type {
  ClientEvent,
  ClientState,
  Command,
  ErrorKind,
  RejectCode,
  ShownRound,
  StateView,
} from './types.ts';
