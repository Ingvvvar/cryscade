// Хост сцены: React владеет только div-хостом, канвас — у рендерера (§10). Сессия живёт в рефе и переживает
// двойной эффект StrictMode; монтирования идут цепочкой внутри SceneMount. Кадры рендер тянет сам из источника —
// часов показа (Presenter): сетка, выигрыш и счётчик идут мимо React (§11: счётчик крутится в Pixi).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Layout } from '../render/layout.ts';
import type { Renderer, SceneSource } from '../render/renderer.ts';
import { DomViewportSource } from './dom-viewport.ts';
import { useGameSnapshot, type Game } from './game.ts';
import type { MoneyFormat } from './money-format.ts';
import { Panel } from './panel.tsx';
import type { TurboSwitch } from './presentation-preferences.ts';
import { rendererFailure, type RendererChoice } from './renderer-choice.ts';
import { SceneSession, type MountObserver } from './scene-session.ts';
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
  readonly money: MoneyFormat;
  readonly reload: () => void;
}

/** Пробел: в покое — спин, во время показа — пропуск или «продолжить». Кнопку и поле ввода пробел нажимает сам. */
function useSpaceKey(game: Game): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return;
      if (event.target instanceof Element && event.target.closest('button, input, select, textarea, [contenteditable]') !== null) return;
      event.preventDefault();
      if (game.getSnapshot().state.name === 'idle') game.spin();
      else game.tap();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [game]);
}

export function SceneHost({ create, choice, observer, game, source, preferences, money, reload }: SceneHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SceneSession | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState(false);
  const snapshot = useGameSnapshot(game);
  const subscribe = useCallback((listener: () => void) => preferences.subscribe(listener), [preferences]);
  const view = useCallback(() => preferences.getSnapshot(), [preferences]);
  const turbo = useSyncExternalStore(subscribe, view);
  const onTurbo = useCallback(() => {
    preferences.toggleTurbo();
  }, [preferences]);
  useSpaceKey(game);

  useEffect(() => {
    const host = hostRef.current;
    const insets = insetRef.current;
    if (host === null || insets === null) return;
    sessionRef.current ??= new SceneSession({
      create,
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
  }, [create, observer, source]);

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
      {layout !== null && <Panel layout={layout} game={game} snapshot={snapshot} turbo={turbo} onTurbo={onTurbo} money={money} />}
      <NoticeBar snapshot={snapshot} />
      <StatusScreen game={game} snapshot={snapshot} reload={reload} />
      {failed && (
        <p role="alert" className="scene-error">
          {rendererFailure(choice)}
        </p>
      )}
    </div>
  );
}
