import { gameTitle } from '../core/model/game.ts';

export function App() {
  return (
    <main className="stub">
      <h1>{gameTitle()}</h1>
      <p>Каркас гри. Кристали з'являться згодом.</p>
    </main>
  );
}
