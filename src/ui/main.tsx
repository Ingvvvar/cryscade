import '@fontsource-variable/unbounded';
import '@fontsource-variable/manrope';
import './styles.css';
import { Profiler, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BroadcastTabChannel,
  GameController,
  MemoryRoundLock,
  NetworkLabTransport,
  PRESETS,
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
import { Autoplay } from './autoplay.ts';
import { LANGUAGES } from './i18n/dictionary.ts';
import { UK } from './i18n/uk.ts';
import { LanguageStore, type DictionaryLoader } from './language.ts';
import type { PageProbe } from './probe.ts';
import { PresentationPreferences } from './presentation-preferences.ts';
import { rendererChoice } from './renderer-choice.ts';
import { replayExit, replayTarget } from './replay-link.ts';
import { SCENE_TEXTS } from './scene-texts.ts';
import { SessionTracker } from './session.ts';
import { SoundGate } from './sound-gate.ts';
import { SettingsStore, jurisdictionParam } from './settings.ts';
import { REDUCED_MOTION_QUERY } from './viewport-watcher.ts';

/** Словарь языка: украинский — в начальном JS, английский — ленивым модулем (LAZY_MODULES гейта сборки). */
const loadDictionary: DictionaryLoader = (language) => (language === 'uk' ? Promise.resolve(UK) : import('./i18n/en.ts').then((module) => module.EN));

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
  // Настройки игрока (§11): язык — сразу, пресет — со следующего раунда; ?jurisdiction= сильнее настройки.
  const settings = new SettingsStore(() => window.localStorage);
  const lockedPreset = jurisdictionParam(window.location.search);
  const language = new LanguageStore(await loadDictionary(settings.getSnapshot().language).catch(() => UK), loadDictionary);
  // Параметры показа читаются при старте раунда (§8.2): переключённые посреди раунда действуют со следующего.
  const preferences = new PresentationPreferences(PRESETS[lockedPreset ?? settings.getSnapshot().preset], window.matchMedia(REDUCED_MOTION_QUERY));
  settings.subscribe(() => {
    const chosen = settings.getSnapshot();
    void language.choose(chosen.language);
    if (lockedPreset === null) preferences.setPreset(PRESETS[chosen.preset]);
  });
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
  // Сессия вкладки (§11): чистый результат закрытых этой вкладкой раундов и время — в sessionStorage.
  const now = (): number => Date.now();
  const session = new SessionTracker(() => window.sessionStorage, now);
  controller.onRoundSettled((round) => {
    session.settle(round);
  });
  // Звук (§12): AudioContext — в первом жесте, модуль звука — лениво; мьют — настройка «Звук», скрытая вкладка — пауза.
  // ?soundleak=1 — положительный контроль замера утечек, только dev и e2e-сборка.
  const leak = (import.meta.env.DEV || import.meta.env.MODE === 'e2e') && new URLSearchParams(window.location.search).get('soundleak') === '1';
  const sound = new SoundGate({
    target: window,
    createContext: () => (typeof AudioContext === 'function' ? new AudioContext() : null),
    load: (context) => import('../audio/index.ts').then((module) => module.createSound(context, { leak })),
    clock: presenter,
    enabled: { getSnapshot: () => settings.getSnapshot().sound, subscribe: (listener) => settings.subscribe(listener) },
    hidden: {
      getSnapshot: () => document.hidden,
      subscribe: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => {
          document.removeEventListener('visibilitychange', listener);
        };
      },
    },
  });
  sound.arm();
  // Автоигра (§11) жмёт «Спін» за игрока; пресет без автоигры (строгий) её не пускает.
  const autoplay = new Autoplay(
    controller,
    (ms, task) => {
      const id = window.setTimeout(task, ms);
      return () => {
        window.clearTimeout(id);
      };
    },
    () => preferences.getSnapshot().preset.autoplay,
  );
  const create = (): Renderer => {
    probe?.noteCreated();
    const current = language.getSnapshot();
    return new PixiRenderer({
      preference: choice.preference,
      inspector: probe?.scene ?? null,
      warmUp: probe?.warmUp ?? true,
      texts: current.scene,
      numbers: current.money.style,
      allTexts: LANGUAGES.map((name) => SCENE_TEXTS[name]),
    });
  };
  const app: ReactNode = (
    <App
        create={create}
        choice={choice}
        observer={probe}
        game={controller}
        source={presenter}
        preferences={preferences}
        reload={reload}
        onSceneReady={() => {
          // Книга исходов — после первого кадра (§5): кадр на следующем тике, запрос — после него.
          requestAnimationFrame(() => {
            controller.prefetchBook();
          });
        }}
        replayExit={replayExit(window.location.href)}
        session={session}
        now={now}
        autoplay={autoplay}
        language={language}
        services={{ settings, lockedPreset, fairness: controller, lab }}
      />
  );
  // Замер рендеров App за раунд (§11) — Profiler только при зонде (dev и e2e-сборка; в e2e — профилирующий react-dom).
  createRoot(root).render(
    <StrictMode>
      {probe === null ? (
        app
      ) : (
        <Profiler id="app" onRender={probe.noteCommit}>
          {app}
        </Profiler>
      )}
    </StrictMode>,
  );
  // Повтор по ссылке (§7): вместо обычного запуска — события раунда без authenticate, замков и кошелька.
  const replay = replayTarget(window.location.search);
  if (replay === null) controller.start();
  else controller.startReplay(replay);
}

void mount();
