import '@fontsource-variable/unbounded';
import '@fontsource-variable/manrope';
import './styles.css';
// Заглушки подключены так, как их подключит сцена (§3): граф импортов проверяется на настоящей проводке.
import '../client/index.ts';
import '../render/pixi/index.ts';
import '../audio/index.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('В index.html нет #root');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
