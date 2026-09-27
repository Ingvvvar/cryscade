import { SceneHost, type SceneHostProps } from './scene-host.tsx';

export function App(props: SceneHostProps) {
  return (
    <main className="app">
      <SceneHost {...props} />
    </main>
  );
}
