// Хост сцены: React владеет только div-хостом, канвас — у рендерера (§10). Сессия живёт в рефе и переживает
// двойной эффект StrictMode; монтирования идут цепочкой внутри SceneMount.

import { useEffect, useRef, useState } from 'react';
import type { SymbolId } from '../core/model/symbols.ts';
import type { Layout } from '../render/layout.ts';
import type { Renderer } from '../render/renderer.ts';
import { DomViewportSource } from './dom-viewport.ts';
import { PanelMock } from './panel-mock.tsx';
import { rendererFailure, type RendererChoice } from './renderer-choice.ts';
import { SceneSession, type MountObserver } from './scene-session.ts';
import { ViewportWatcher } from './viewport-watcher.ts';

export interface SceneHostProps {
  readonly create: () => Renderer;
  readonly grid: readonly SymbolId[];
  readonly choice: RendererChoice;
  readonly observer: MountObserver | null;
}

export function SceneHost({ create, grid, choice, observer }: SceneHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SceneSession | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const insets = insetRef.current;
    if (host === null || insets === null) return;
    sessionRef.current ??= new SceneSession({
      create,
      grid,
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
  }, [create, grid, observer]);

  return (
    <div className="scene">
      <div ref={hostRef} className="scene-host" />
      <div ref={insetRef} className="safe-area-probe" aria-hidden="true" />
      {layout !== null && <PanelMock layout={layout} />}
      {failed && (
        <p role="alert" className="scene-error">
          {rendererFailure(choice)}
        </p>
      )}
    </div>
  );
}
