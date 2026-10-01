// Хост сцены: React владеет только div-хостом, канвас — у рендерера (§10). Сессия живёт в рефе и переживает
// двойной эффект StrictMode; монтирования идут цепочкой внутри SceneMount. Кадры рендер тянет сам из источника —
// часов показа (Presenter): сетка, выигрыш и счётчик идут мимо React (§11: счётчик крутится в Pixi).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { Layout } from '../render/layout.ts';
import type { Renderer, SceneSource } from '../render/renderer.ts';
import type { AutoplayControl } from './autoplay-controls.tsx';
import type { DialogName } from './dialog-host.tsx';
import { DomViewportSource } from './dom-viewport.ts';
import type { ExternalSource } from './external.ts';
import { useGameSnapshot, type Game } from './game.ts';
import { useLanguage } from './language-context.ts';
import { Panel } from './panel.tsx';
import type { TurboSwitch } from './presentation-preferences.ts';
import { rendererFailure, type RendererChoice } from './renderer-choice.ts';
import { SceneSession, type MountObserver } from './scene-session.ts';
import type { SessionView } from './session.ts';
import { NoticeBar, StatusScreen } from './status.tsx';
import { ViewportWatcher } from './viewport-watcher.ts';

export interface SceneHostProps {
  readonly create: () => Renderer;
  readonly choice: RendererChoice;
  readonly observer: MountObserver | null;
  readonly game: Game;
  /** Часы показа: из них рендер тянет кадры. */
  readonly source: SceneSource;
  readonly preferences: TurboSwitch;
  readonly reload: () => void;
  /** Сцена готова: корень композиции просит книгу исходов после её первого кадра. */
  readonly onSceneReady: () => void;
  /** Выход из повтора — обычный запуск страницы. */
  readonly replayExit: string;
  readonly session: ExternalSource<SessionView>;
  /** Часы для времени сессии — из корня композиции. */
  readonly now: () => number;
  readonly onOpenDialog: (name: DialogName, returnFocus: HTMLElement | null) => void;
  readonly autoplay: AutoplayControl;
  readonly sound: boolean;
  readonly onSound: () => void;
}

/**
 * Клавиатура (§11): пробел — в покое спин, во время показа пропуск или «продолжить» (кнопку и поле ввода пробел
 * нажимает сам); + и − — ставка. Внутри диалога и popover клавиши игры не действуют: там свои.
 */
function useGameKeys(game: Game): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const inside = (selector: string): boolean => target !== null && target.closest(selector) !== null;
      if (inside('dialog, [popover], input, select, textarea, [contenteditable]')) return;
      if (event.code === 'Space') {
        if (inside('button, a')) return;
        event.preventDefault();
        if (game.getSnapshot().state.name === 'idle') game.spin();
        else game.tap();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        game.betUp();
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        game.betDown();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [game]);
}

/**
 * Итог раунда — экранному диктору (§11): одно объявление на раунд, когда раунд закрыт, — не на каждый каскад. Текст
 * ставится через ref: рендеров React нет.
 */
function useRoundAnnouncer(game: Game): RefObject<HTMLParagraphElement | null> {
  const ref = useRef<HTMLParagraphElement>(null);
  const { dict, money } = useLanguage();
  useEffect(
    () =>
      game.onRoundSettled((round) => {
        const balance = money.format(round.balanceMinor);
        const text = round.winMinor > 0 ? dict.announce.win(money.format(round.winMinor), balance) : dict.announce.noWin(balance);
        if (ref.current !== null) ref.current.textContent = text;
      }),
    [game, dict, money],
  );
  return ref;
}

export function SceneHost({
  create,
  choice,
  observer,
  game,
  source,
  preferences,
  reload,
  onSceneReady,
  replayExit,
  session,
  now,
  onOpenDialog,
  autoplay,
  sound,
  onSound,
}: SceneHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SceneSession | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState(false);
  const snapshot = useGameSnapshot(game);
  const language = useLanguage();
  const subscribe = useCallback((listener: () => void) => preferences.subscribe(listener), [preferences]);
  const view = useCallback(() => preferences.getSnapshot(), [preferences]);
  const turbo = useSyncExternalStore(subscribe, view);
  const onTurbo = useCallback(() => {
    preferences.toggleTurbo();
  }, [preferences]);
  useGameKeys(game);
  const announcer = useRoundAnnouncer(game);

  useEffect(() => {
    const host = hostRef.current;
    const insets = insetRef.current;
    if (host === null || insets === null) return;
    sessionRef.current ??= new SceneSession({
      create,
      onReady: onSceneReady,
      onLayout: setLayout,
      onError: () => {
        setFailed(true);
      },
      observer,
    });
    const session = sessionRef.current;
    session.setSource(source);
    session.attach(host);
    const watcher = new ViewportWatcher(window, new DomViewportSource(host, insets), session);
    watcher.start();
    observer?.bindRemount(() => {
      session.detach();
      session.attach(host);
    });
    return () => {
      observer?.bindRemount(null);
      watcher.dispose();
      session.detach();
    };
  }, [create, observer, source, onSceneReady]);

  // Язык игрока — надписям и суммам сцены: на живом рендерере сразу, новому — по готовности.
  useEffect(() => {
    sessionRef.current?.setLanguage(language.scene, language.money.style);
  }, [language]);

  return (
    <div className="scene">
      <div
        ref={hostRef}
        className="scene-host"
        onPointerDown={() => {
          game.tap();
        }}
      />
      <div ref={insetRef} className="safe-area-probe" aria-hidden="true" />
      {layout !== null && (
        <Panel
          layout={layout}
          game={game}
          snapshot={snapshot}
          turbo={turbo}
          onTurbo={onTurbo}
          session={session}
          now={now}
          onOpenDialog={onOpenDialog}
          autoplay={autoplay}
          sound={sound}
          onSound={onSound}
        />
      )}
      <NoticeBar snapshot={snapshot} exitHref={replayExit} autoplay={autoplay} />
      <p ref={announcer} className="sr-only" role="status" aria-live="polite" data-testid="announcer" />
      <StatusScreen game={game} snapshot={snapshot} reload={reload} exitHref={replayExit} />
      {failed && (
        <p role="alert" className="scene-error">
          {rendererFailure(choice)}
        </p>
      )}
    </div>
  );
}
