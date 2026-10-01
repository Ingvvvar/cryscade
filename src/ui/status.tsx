// Состояния поверх игры (§6.5, §6.6): полоса уведомлений о хранилище и отказе спину, экран ошибки с «Повторити» или
// перезагрузкой, ожидание чужой вкладки с «Грати тут» — сразу, без паузы: нажатие — явное намерение игрока, деньги
// держит сервер.

import type { ControllerSnapshot } from '../client/index.ts';
import type { Game } from './game.ts';
import { ERROR_TEXT, NOTICE_TEXT, REFUSAL_TEXT, TEXT } from './texts.ts';

export interface StatusProps {
  readonly game: Game;
  readonly snapshot: ControllerSnapshot;
  /** Перезагрузка страницы — из корня композиции. */
  readonly reload: () => void;
  /** Выход из повтора в обычный запуск: перезагрузка повтора дала бы ту же ошибку. */
  readonly exitHref: string;
}

/** Полосы над сценой; exitHref — выход из повтора в обычный запуск. */
export function NoticeBar({ snapshot, exitHref }: { readonly snapshot: ControllerSnapshot; readonly exitHref: string }) {
  const { state, notice } = snapshot;
  const refusal = state.name === 'idle' && state.refusal !== null ? (REFUSAL_TEXT[state.refusal] ?? null) : null;
  const replay = snapshot.mode === 'replay';
  if (notice === null && refusal === null && !replay) return null;
  return (
    <div className="notices" role="status">
      {replay && (
        <p className="notice notice-replay" data-notice="replay">
          {TEXT.replay}
          <a className="notice-link" href={exitHref}>
            {TEXT.replayExit}
          </a>
        </p>
      )}
      {notice !== null && (
        <p className={`notice notice-${notice}`} data-notice={notice}>
          {NOTICE_TEXT[notice]}
        </p>
      )}
      {refusal !== null && <p className="notice notice-refusal">{refusal}</p>}
    </div>
  );
}

export function StatusScreen({ game, snapshot, reload, exitHref }: StatusProps) {
  const { state } = snapshot;
  if (state.name === 'error') {
    return (
      <div className="status-screen" role="alert" data-state="error" data-kind={state.kind}>
        <p className="status-text">{ERROR_TEXT[state.kind]}</p>
        {state.retry === null && snapshot.mode === 'replay' ? (
          <a className="status-action" href={exitHref}>
            {TEXT.replayExit}
          </a>
        ) : state.retry === null ? (
          <button type="button" className="status-action" onClick={reload}>
            {TEXT.reload}
          </button>
        ) : (
          <button
            type="button"
            className="status-action"
            onClick={() => {
              game.retry();
            }}
          >
            {TEXT.retry}
          </button>
        )}
      </div>
    );
  }
  if (state.name === 'waitingForTab') {
    return (
      <div className="status-screen" role="status" data-state="waitingForTab">
        <p className="status-text">{TEXT.waiting}</p>
        <button
          type="button"
          className="status-action"
          disabled={state.stealing}
          onClick={() => {
            game.takeOver();
          }}
        >
          {TEXT.playHere}
        </button>
      </div>
    );
  }
  return null;
}
