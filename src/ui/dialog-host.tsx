// Хозяин диалогов (§11): модуль диалога грузится динамическим импортом по первому открытию — диалоги ленивые и лежат вне
// начального JS (LAZY_MODULES гейта сборки). Не загрузился — диалог не открывается, игра идёт. Без React.lazy: отказ
// загрузки ловится здесь, а не границей ошибок.

import { useCallback, useState, type ComponentType, type ReactNode } from 'react';
import type { DialogProps, DialogServices } from './dialogs/services.ts';
import type { InputKind } from './input-modality.ts';

export type DialogName = 'rules' | 'settings' | 'history' | 'fairness' | 'lab';

type DialogComponent = ComponentType<DialogProps>;

const LOADERS: Readonly<Record<DialogName, () => Promise<DialogComponent>>> = {
  rules: () => import('./dialogs/rules-dialog.tsx').then((module) => module.RulesDialog),
  settings: () => import('./dialogs/settings-dialog.tsx').then((module) => module.SettingsDialog),
  history: () => import('./dialogs/history-dialog.tsx').then((module) => module.HistoryDialog),
  fairness: () => import('./dialogs/fairness-dialog.tsx').then((module) => module.FairnessDialog),
  lab: () => import('./dialogs/lab-dialog.tsx').then((module) => module.LabDialog),
};

interface OpenDialog {
  readonly Component: DialogComponent;
  readonly returnFocus: HTMLElement | null;
  readonly openedBy: InputKind | null;
}

interface DialogHost {
  readonly open: (name: DialogName, returnFocus: HTMLElement | null) => void;
  readonly element: ReactNode;
}

/**
 * Открытый диалог и функция открытия. Модальный диалог закрывает страницу — второй поверх него не открыть. Чем открыт —
 * последний ввод в момент открытия, до загрузки модуля: пока он грузится, игрок мог коснуться чего-то ещё.
 */
export function useDialogs(services: DialogServices): DialogHost {
  const [current, setCurrent] = useState<OpenDialog | null>(null);
  const open = useCallback(
    (name: DialogName, returnFocus: HTMLElement | null) => {
      const openedBy = services.input.last;
      void LOADERS[name]().then(
        (Component) => {
          setCurrent({ Component, returnFocus, openedBy });
        },
        () => undefined,
      );
    },
    [services],
  );
  const close = useCallback(() => {
    setCurrent(null);
  }, []);
  const element = current === null ? null : <current.Component services={services} onClose={close} returnFocus={current.returnFocus} openedBy={current.openedBy} />;
  return { open, element };
}
