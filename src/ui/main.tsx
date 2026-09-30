import '@fontsource-variable/unbounded';
import '@fontsource-variable/manrope';
import './styles.css';
// Звук подключён так, как его подключит сцена (§3): граф импортов проверяется на настоящей проводке.
import '../audio/index.ts'; // wiring
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BroadcastTabChannel,
  GameController,
  MemoryRoundLock,
  NetworkLabTransport,
  Presenter,
  RgsClient,
  SessionCheckpoint,
  TimeoutSleep,
  UuidKeys,
  WebRoundLock,
  WorkerTransport,
} from '../client/index.ts';
import { TAB_CHANNEL } from '../protocol/index.ts';
import { PixiRenderer } from '../render/pixi/pixi-renderer.ts';
import type { Renderer } from '../render/renderer.ts';
import { App } from './App.tsx';
import { MoneyFormat } from './money-format.ts';
import type { PageProbe } from './probe.ts';
import { PresentationPreferences, presetChoice } from './presentation-preferences.ts';
import { rendererChoice } from './renderer-choice.ts';
import { SCENE_TEXT } from './texts.ts';
import { REDUCED_MOTION_QUERY } from './viewport-watcher.ts';

/** Тестовый зонд — только dev и e2e-сборка: в проде условие ложно, ветка и её динамический импорт выпадают. */
async function loadProbe(): Promise<PageProbe | null> {
  if (!(import.meta.env.DEV || import.meta.env.MODE === 'e2e')) return null;
  const { PageProbe } = await import('./probe.ts');
  const probe = new PageProbe();
  probe.install(window);
  return probe;
}

// Корень композиции главного потока (§3): связывание — внутри функции, не на уровне модуля. Сервер — в воркере:
// клиент знает его только по URL, это не импорт. Лаборатория сети — всегда в цепочке, по умолчанию прозрачна.
async function mount(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) {
    throw new Error('В index.html нет #root');
  }
  const probe = await loadProbe();
  const choice = rendererChoice(window.location.search);
  const reload = (): void => {
    window.location.reload();
  };
  const transport = new WorkerTransport(() => new Worker(new URL('../server/worker.ts', import.meta.url), { type: 'module' }));
  const sleep = new TimeoutSleep();
  const lab = new NetworkLabTransport(probe?.record(transport) ?? transport, sleep, { random: Math.random, reload });
  // Параметры показа читаются при старте раунда (§8.2): переключённые посреди раунда действуют со следующего.
  const preferences = new PresentationPreferences(presetChoice(window.location.search), window.matchMedia(REDUCED_MOTION_QUERY));
  const presenter = new Presenter(preferences, new SessionCheckpoint(() => window.sessionStorage));
  // Скрытая вкладка — часы показа стоят; уход со страницы — контрольная точка раунда (§6.5, §8.2).
  const onVisibility = (): void => {
    presenter.setHidden(document.hidden);
  };
  onVisibility();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => {
    presenter.saveCheckpoint();
  });
  const controller = new GameController({
    rgs: new RgsClient(lab, sleep),
    roundLock: new WebRoundLock(navigator.locks),
    localLock: new MemoryRoundLock(),
    channel: new BroadcastTabChannel(new BroadcastChannel(TAB_CHANNEL)),
    notices: transport,
    keys: new UuidKeys(() => crypto.randomUUID()),
    presentation: presenter,
  });
  probe?.bindGame(controller, lab);
  probe?.bindPresenter(presenter);
  const money = new MoneyFormat('uk-UA');
  const create = (): Renderer => {
    probe?.noteCreated();
    return new PixiRenderer({
      preference: choice.preference,
      inspector: probe?.scene ?? null,
      warmUp: probe?.warmUp ?? true,
      texts: SCENE_TEXT,
      numbers: money.style,
    });
  };
  createRoot(root).render(
    <StrictMode>
      <App
        create={create}
        choice={choice}
        observer={probe}
        game={controller}
        source={presenter}
        preferences={preferences}
        money={money}
        reload={reload}
        onSceneReady={() => {
          // Книга исходов — после первого кадра (§5): кадр на следующем тике, запрос — после него.
          requestAnimationFrame(() => {
            controller.prefetchBook();
          });
        }}
      />
    </StrictMode>,
  );
  controller.start();
}

void mount();
