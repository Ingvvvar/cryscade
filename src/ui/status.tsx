// Состояния поверх игры (§6.5, §6.6): полоса уведомлений о хранилище и отказе спину, экран ошибки с «Повторити» или
// перезагрузкой, ожидание чужой вкладки с «Грати тут» — сразу, без паузы: нажатие — явное намерение игрока, деньги
// держит сервер.

import type { ControllerSnapshot } from '../client/index.ts';
import { AutoplayBar, type AutoplayControl } from './autoplay-controls.tsx';
import type { Game } from './game.ts';
import { useLanguage } from './language-context.ts';

interface StatusProps {
  readonly game: Game;
  readonly snapshot: ControllerSnapshot;
  /** Перезагрузка страницы — из корня композиции. */
  readonly reload: () => void;
  /** Выход из повтора в обычный запуск: перезагрузка повтора дала бы ту же ошибку. */
  readonly exitHref: string;
}

/**
 * Полосы над сценой; exitHref — выход из повтора в обычный запуск. Хранилище, отказ спину и повтор — живой областью
 * (role="status"); полоса автоигры — вне её: ход серии диктор не читает на каждом раунде, итог раунда объявляет свой
 * aria-live.
 */
export function NoticeBar({ snapshot, exitHref, autoplay }: { readonly snapshot: ControllerSnapshot; readonly exitHref: string; readonly autoplay: AutoplayControl }) {
  const { dict } = useLanguage();
  const { state, notice } = snapshot;
  const refusal = state.name === 'idle' && state.refusal !== null ? (dict.refusal[state.refusal] ?? null) : null;
  const replay = snapshot.mode === 'replay';
  return (
    <div className="notices">
      <AutoplayBar autoplay={autoplay} />
      {(notice !== null || refusal !== null || replay) && (
        <NoticeLines replay={replay} notice={notice} refusal={refusal} exitHref={exitHref} />
      )}
    </div>
  );
}

function NoticeLines({
  replay,
  notice,
  refusal,
  exitHref,
}: {
  readonly replay: boolean;
  readonly notice: ControllerSnapshot['notice'];
  readonly refusal: string | null;
  readonly exitHref: string;
}) {
  const { dict } = useLanguage();
  return (
    <div className="notice-list" role="status">
      {replay && (
        <p className="notice notice-replay" data-notice="replay">
          {dict.text.replay}
          <a className="notice-link" href={exitHref}>
            {dict.text.replayExit}
          </a>
        </p>
      )}
      {notice !== null && (
        <p className={`notice notice-${notice}`} data-notice={notice}>
          {dict.notice[notice]}
        </p>
      )}
      {refusal !== null && <p className="notice notice-refusal">{refusal}</p>}
    </div>
  );
}

export function StatusScreen({ game, snapshot, reload, exitHref }: StatusProps) {
  const { dict } = useLanguage();
  const text = dict.text;
  const { state } = snapshot;
  if (state.name === 'error') {
    return (
      <div className="status-screen" role="alert" data-state="error" data-kind={state.kind}>
        <p className="status-text">{dict.error[state.kind]}</p>
        {state.retry === null && snapshot.mode === 'replay' ? (
          <a className="status-action" href={exitHref}>
            {text.replayExit}
          </a>
        ) : state.retry === null ? (
          <button type="button" className="status-action" onClick={reload}>
            {text.reload}
          </button>
        ) : (
          <button
            type="button"
            className="status-action"
            onClick={() => {
              game.retry();
            }}
          >
            {text.retry}
          </button>
        )}
      </div>
    );
  }
  if (state.name === 'waitingForTab') {
    return (
      <div className="status-screen" role="status" data-state="waitingForTab">
        <p className="status-text">{text.waiting}</p>
        <button
          type="button"
          className="status-action"
          disabled={state.stealing}
          onClick={() => {
            game.takeOver();
          }}
        >
          {text.playHere}
        </button>
      </div>
    );
  }
  return null;
}
