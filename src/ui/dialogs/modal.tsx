// Диалог (§11): нативный <dialog> в модальном режиме — Esc, фон и ловушку фокуса браузер берёт на себя. Фокус по
// закрытии возвращаем сами: Chromium возвращает его открывшему, WebKit — нет (проба фазы 7). Первым фокус получает
// элемент с data-autofocus, иначе — первый в диалоге.

import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ModalProps {
  /** Имя для тестов и стилей: data-dialog. */
  readonly name: string;
  readonly title: string;
  readonly closeLabel: string;
  /** Диалог закрылся — Esc, кнопкой или формой; стабильная функция. */
  readonly onClose: () => void;
  /** Куда вернуть фокус, когда диалог закрылся. */
  readonly returnFocus: HTMLElement | null;
  readonly children: ReactNode;
}

export function Modal({ name, title, closeLabel, onClose, returnFocus, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const closed = (): void => {
      returnFocus?.focus();
      onClose();
    };
    dialog.addEventListener('close', closed);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      dialog.removeEventListener('close', closed);
      if (dialog.open) dialog.close();
    };
  }, [onClose, returnFocus]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} data-dialog={name}>
      <header className="modal-head">
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <button
          type="button"
          className="modal-close"
          aria-label={closeLabel}
          onClick={() => {
            ref.current?.close();
          }}
        >
          ×
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
