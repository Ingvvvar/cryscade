// Что диалоги получают от корня композиции (§11): хранилища и действия. Диалоги ленивые — их модули грузятся по первому
// открытию; хозяин диалогов (dialog-host.tsx) отдаёт каждому один и тот же набор, диалог берёт нужное.

import type { PresetName } from '../../client/index.ts';
import type { ExternalSource } from '../external.ts';
import type { Language } from '../i18n/dictionary.ts';
import type { SettingsView } from '../settings.ts';

export interface SettingsControl extends ExternalSource<SettingsView> {
  setLanguage(language: Language): void;
  setPreset(preset: PresetName): void;
}

export interface DialogServices {
  readonly settings: SettingsControl;
  /** Пресет из ссылки (?jurisdiction=) — настройка его не меняет; null — решает настройка. */
  readonly lockedPreset: PresetName | null;
}

export interface DialogProps {
  readonly services: DialogServices;
  readonly onClose: () => void;
  readonly returnFocus: HTMLElement | null;
}
