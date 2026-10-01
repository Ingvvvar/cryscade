// Хозяин диалогов (§11): модуль диалога грузится динамическим импортом по первому открытию — диалоги ленивые и лежат вне
// начального JS (LAZY_MODULES гейта сборки). Не загрузился — диалог не открывается, игра идёт. Без React.lazy: отказ
// загрузки ловится здесь, а не границей ошибок.

import { useCallback, useState, type ComponentType, type ReactNode } from 'react';
import type { DialogProps, DialogServices } from './dialogs/services.ts';

export type DialogName = 'settings';

type DialogComponent = ComponentType<DialogProps>;

const LOADERS: Readonly<Record<DialogName, () => Promise<DialogComponent>>> = {
  settings: () => import('./dialogs/settings-dialog.tsx').then((module) => module.SettingsDialog),
};

interface OpenDialog {
  readonly Component: DialogComponent;
  readonly returnFocus: HTMLElement | null;
}

export interface DialogHost {
  readonly open: (name: DialogName, returnFocus: HTMLElement | null) => void;
  readonly element: ReactNode;
}

/** Открытый диалог и функция открытия. Модальный диалог закрывает страницу — второй поверх него не открыть. */
export function useDialogs(services: DialogServices): DialogHost {
  const [current, setCurrent] = useState<OpenDialog | null>(null);
  const open = useCallback((name: DialogName, returnFocus: HTMLElement | null) => {
    void LOADERS[name]().then(
      (Component) => {
        setCurrent({ Component, returnFocus });
      },
      () => undefined,
    );
  }, []);
  const close = useCallback(() => {
    setCurrent(null);
  }, []);
  const element = current === null ? null : <current.Component services={services} onClose={close} returnFocus={current.returnFocus} />;
  return { open, element };
}
