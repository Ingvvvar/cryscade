// Корень React (§11): язык игрока — контекстом всем компонентам, сцена с панелью и хозяин диалогов. Состояние живёт
// вне React — в хранилищах из корня композиции; здесь — только снимки через useSyncExternalStore.

import { useCallback, useEffect } from 'react';
import { useDialogs } from './dialog-host.tsx';
import type { DialogServices } from './dialogs/services.ts';
import { useExternal, type ExternalSource } from './external.ts';
import { LanguageContext } from './language-context.ts';
import type { LanguageView } from './language.ts';
import { SceneHost, type SceneHostProps } from './scene-host.tsx';

interface AppProps extends Omit<SceneHostProps, 'onOpenDialog' | 'sound' | 'onSound'> {
  readonly language: ExternalSource<LanguageView>;
  readonly services: DialogServices;
}

export function App({ language, services, ...scene }: AppProps) {
  const view = useExternal(language);
  const dialogs = useDialogs(services);
  const settings = useExternal(services.settings);
  const onSound = useCallback(() => {
    services.settings.setSound(!services.settings.getSnapshot().sound);
  }, [services]);
  useEffect(() => {
    document.documentElement.lang = view.dict.language;
  }, [view]);
  return (
    <LanguageContext value={view}>
      <main className="app">
        <SceneHost {...scene} onOpenDialog={dialogs.open} sound={settings.sound} onSound={onSound} />
        {dialogs.element}
      </main>
    </LanguageContext>
  );
}
