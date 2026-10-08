// Что диалоги получают от корня композиции (§11): хранилища и действия. Диалоги ленивые — их модули грузятся по первому
// открытию; хозяин диалогов (dialog-host.tsx) отдаёт каждому один и тот же набор, диалог берёт нужное.

import type { CallOutcome, LabSettings, PresetName } from '../../client/index.ts';
import type { FairnessView, HistoryResult, SeedResult, VerifyResult } from '../../protocol/index.ts';
import type { SymbolIcons } from '../../render/renderer.ts';
import type { ExternalSource } from '../external.ts';
import type { Language } from '../i18n/dictionary.ts';
import type { SettingsView } from '../settings.ts';

interface SettingsControl extends ExternalSource<SettingsView> {
  setLanguage(language: Language): void;
  setPreset(preset: PresetName): void;
  setSound(sound: boolean): void;
}

/** История и честность (§7) — запросы мимо машины состояний; реализует контроллер игры. */
export interface FairnessControl {
  fairness(): Promise<CallOutcome<FairnessView | null>>;
  history(limit: number): Promise<CallOutcome<HistoryResult>>;
  setClientSeed(clientSeed: string): Promise<CallOutcome<SeedResult>>;
  rotateSeed(): Promise<CallOutcome<SeedResult>>;
  verify(secret: string, clientSeed: string, nonce: number): Promise<CallOutcome<VerifyResult>>;
}

/** Лаборатория сети (§6.5): настройки и разовые действия — тот же декоратор транспорта, что всегда в цепочке. */
interface LabControl {
  readonly settings: LabSettings;
  set(settings: Partial<LabSettings>): void;
  loseNextResponse(): void;
  reloadMidNextRound(): void;
  holdNextEndRound(): void;
  releaseHeld(): void;
}

export interface DialogServices {
  readonly settings: SettingsControl;
  /** Пресет из ссылки (?jurisdiction=) — настройка его не меняет; null — решает настройка. */
  readonly lockedPreset: PresetName | null;
  readonly fairness: FairnessControl;
  readonly lab: LabControl;
  /** Иконки символов для правил — из атласа живого рендерера. */
  readonly icons: SymbolIcons;
}

export interface DialogProps {
  readonly services: DialogServices;
  readonly onClose: () => void;
  readonly returnFocus: HTMLElement | null;
}
