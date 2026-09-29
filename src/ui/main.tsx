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
  RgsClient,
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
import { rendererChoice } from './renderer-choice.ts';

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
  const controller = new GameController({
    rgs: new RgsClient(lab, sleep),
    roundLock: new WebRoundLock(navigator.locks),
    localLock: new MemoryRoundLock(),
    channel: new BroadcastTabChannel(new BroadcastChannel(TAB_CHANNEL)),
    notices: transport,
    keys: new UuidKeys(() => crypto.randomUUID()),
  });
  probe?.bindGame(controller, lab);
  const money = new MoneyFormat('uk-UA');
  const create = (): Renderer => {
    probe?.noteCreated();
    return new PixiRenderer({ preference: choice.preference, inspector: probe?.scene ?? null, warmUp: probe?.warmUp ?? true });
  };
  createRoot(root).render(
    <StrictMode>
      <App create={create} choice={choice} observer={probe} game={controller} money={money} reload={reload} />
    </StrictMode>,
  );
  controller.start();
}

void mount();
