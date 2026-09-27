import '@fontsource-variable/unbounded';
import '@fontsource-variable/manrope';
import './styles.css';
// Заглушки подключены так, как их подключит сцена (§3): граф импортов проверяется на настоящей проводке.
import '../client/index.ts'; // wiring
import '../audio/index.ts'; // wiring
import round from '../../fixtures/rounds/feature-start.json'; // wiring
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PixiRenderer } from '../render/pixi/pixi-renderer.ts';
import type { Renderer } from '../render/renderer.ts';
import { App } from './App.tsx';
import { firstGrid } from './fixture-grid.ts';
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

// Корень композиции главного потока: связывание — внутри функции, не на уровне модуля.
async function mount(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) {
    throw new Error('В index.html нет #root');
  }
  const probe = await loadProbe();
  const choice = rendererChoice(window.location.search);
  // До фазы 4 раундов от сервера нет: срез показывает первую сетку фикстуры (§15, фаза 3).
  const grid = firstGrid(round);
  const create = (): Renderer => {
    probe?.noteCreated();
    return new PixiRenderer({ preference: choice.preference, inspector: probe?.scene ?? null });
  };
  createRoot(root).render(
    <StrictMode>
      <App create={create} grid={grid} choice={choice} observer={probe} />
    </StrictMode>,
  );
}

void mount();
