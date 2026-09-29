// Хост сцены: React владеет только div-хостом, канвас — у рендерера (§10). Сессия живёт в рефе и переживает
// двойной эффект StrictMode; монтирования идут цепочкой внутри SceneMount. Сетку и число выигрыша сессия берёт из
// снимка контроллера: сетку покоя присылает authenticate, дальше — итоговая сетка показанного раунда.

import { useEffect, useRef, useState } from 'react';
import type { SymbolId } from '../core/model/symbols.ts';
import type { Layout } from '../render/layout.ts';
import type { Renderer } from '../render/renderer.ts';
import { DomViewportSource } from './dom-viewport.ts';
import { useGameSnapshot, type Game } from './game.ts';
import type { MoneyFormat } from './money-format.ts';
import { Panel } from './panel.tsx';
import { rendererFailure, type RendererChoice } from './renderer-choice.ts';
import { SceneSession, type MountObserver } from './scene-session.ts';
import { NoticeBar, StatusScreen } from './status.tsx';
import { ViewportWatcher } from './viewport-watcher.ts';

export interface SceneHostProps {
  readonly create: () => Renderer;
  readonly choice: RendererChoice;
  readonly observer: MountObserver | null;
  readonly game: Game;
  readonly money: MoneyFormat;
  readonly reload: () => void;
}

export function SceneHost({ create, choice, observer, game, money, reload }: SceneHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SceneSession | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState(false);
  const snapshot = useGameSnapshot(game);

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
  }, [create, observer]);

  const { grid, winMinor } = snapshot;
  useEffect(() => {
    // Сетку проверил гард протокола: 49 символов от 0 до 7 (isSymbolGrid, события — checkRoundEvents).
    if (grid !== null) sessionRef.current?.showGrid(grid as readonly SymbolId[]);
  }, [grid]);
  useEffect(() => {
    sessionRef.current?.showWin(money.format(winMinor ?? 0));
  }, [winMinor, money]);

  return (
    <div className="scene">
      <div ref={hostRef} className="scene-host" />
      <div ref={insetRef} className="safe-area-probe" aria-hidden="true" />
      {layout !== null && <Panel layout={layout} game={game} snapshot={snapshot} money={money} />}
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
