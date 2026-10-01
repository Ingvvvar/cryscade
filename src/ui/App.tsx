// Корень React (§11): язык игрока — контекстом всем компонентам, сцена с панелью и хозяин диалогов. Состояние живёт
// вне React — в хранилищах из корня композиции; здесь — только снимки через useSyncExternalStore.

import { useEffect } from 'react';
import { useDialogs } from './dialog-host.tsx';
import type { DialogServices } from './dialogs/services.ts';
import { useExternal, type ExternalSource } from './external.ts';
import { LanguageContext } from './language-context.ts';
import type { LanguageView } from './language.ts';
import { SceneHost, type SceneHostProps } from './scene-host.tsx';

export interface AppProps extends Omit<SceneHostProps, 'onOpenDialog'> {
  readonly language: ExternalSource<LanguageView>;
  readonly services: DialogServices;
}

export function App({ language, services, ...scene }: AppProps) {
  const view = useExternal(language);
  const dialogs = useDialogs(services);
  useEffect(() => {
    document.documentElement.lang = view.dict.language;
  }, [view]);
  return (
    <LanguageContext value={view}>
      <main className="app">
        <SceneHost {...scene} onOpenDialog={dialogs.open} />
        {dialogs.element}
      </main>
    </LanguageContext>
  );
}
