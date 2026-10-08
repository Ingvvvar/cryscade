// Настройки (§11, решение 5 фазы 7): язык — сразу, пресет — со следующего раунда; пресет из ссылки настройка не меняет;
// звук (§12) — сразу, мьют обеих шин. Ленивый модуль: в начальном JS его нет (LAZY_MODULES гейта сборки).

import type { PresetName } from '../../client/index.ts';
import { useExternal } from '../external.ts';
import { LANGUAGE_NAMES, LANGUAGES } from '../i18n/dictionary.ts';
import { useLanguage } from '../language-context.ts';
import { Modal } from './modal.tsx';
import type { DialogProps } from './services.ts';

const PRESET_ORDER: readonly PresetName[] = ['standard', 'strict'];
/** Подпись пресета — ключ словаря по его имени: имя пресета код не сравнивает (§1.6). */
const PRESET_LABEL = { standard: 'presetStandard', strict: 'presetStrict' } as const satisfies Record<PresetName, string>;

export function SettingsDialog({ services, onClose, returnFocus }: DialogProps) {
  const { dict } = useLanguage();
  const settings = useExternal(services.settings);
  const locked = services.lockedPreset;
  const preset = locked ?? settings.preset;
  return (
    <Modal name="settings" title={dict.text.settings} closeLabel={dict.text.close} onClose={onClose} returnFocus={returnFocus}>
      <fieldset className="field">
        <legend className="field-title">{dict.text.language}</legend>
        {LANGUAGES.map((language) => (
          <label key={language} className="choice">
            <input
              type="radio"
              name="language"
              value={language}
              checked={settings.language === language}
              data-autofocus={settings.language === language ? '' : undefined}
              onChange={() => {
                services.settings.setLanguage(language);
              }}
            />
            <span lang={language}>{LANGUAGE_NAMES[language]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field" disabled={locked !== null}>
        <legend className="field-title">{dict.text.preset}</legend>
        {PRESET_ORDER.map((name) => (
          <label key={name} className="choice">
            <input
              type="radio"
              name="preset"
              value={name}
              checked={preset === name}
              onChange={() => {
                services.settings.setPreset(name);
              }}
            />
            <span>{dict.text[PRESET_LABEL[name]]}</span>
          </label>
        ))}
        <p className="field-hint">{locked === null ? dict.text.presetNext : dict.text.presetLocked}</p>
      </fieldset>
      <fieldset className="field">
        <legend className="field-title">{dict.text.sound}</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={settings.sound}
            onChange={(event) => {
              services.settings.setSound(event.target.checked);
            }}
          />
          <span>{dict.text.soundOn}</span>
        </label>
      </fieldset>
    </Modal>
  );
}
