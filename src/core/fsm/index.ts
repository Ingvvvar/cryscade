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
  RequestingState,
  RestoringState,
  WaitingForTabState,
  initialState,
} from './states.ts';
export type {
  ClientEvent,
  ClientEventType,
  ClientState,
  Command,
  ErrorKind,
  RejectCode,
  RetryTarget,
  ShownRound,
  StateName,
  StateView,
  Transition,
} from './types.ts';
