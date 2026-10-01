// Лаборатория сети (§6.5, §11, решение 2 фазы 7): в проде, лениво — ревьюер провоцирует сбои на живом адресе. Диалог
// работает с тем же декоратором транспорта, что всегда стоит в цепочке (NetworkLabTransport): задержка, разброс, потеря
// запросов и ответов — сразу; разовые действия — на следующий запрос. Ленивый модуль (LAZY_MODULES гейта сборки).

import { useId, useState } from 'react';
import type { LabSettings } from '../../client/index.ts';
import { useLanguage } from '../language-context.ts';
import { Modal } from './modal.tsx';
import type { DialogProps } from './services.ts';

interface Field {
  readonly key: keyof LabSettings;
  readonly max: number;
  readonly step: number;
  /** Доля потерь показывается процентами: в настройке — от 0 до 1. */
  readonly percent: boolean;
}

const FIELDS: readonly Field[] = [
  { key: 'latencyMs', max: 5000, step: 50, percent: false },
  { key: 'jitterMs', max: 2000, step: 50, percent: false },
  { key: 'requestLoss', max: 100, step: 5, percent: true },
  { key: 'responseLoss', max: 100, step: 5, percent: true },
];

const CLEAR: LabSettings = { latencyMs: 0, jitterMs: 0, requestLoss: 0, responseLoss: 0 };

type Action = 'loseNextResponse' | 'reloadMidNextRound' | 'holdNextEndRound' | 'releaseHeld';

const ACTIONS: readonly Action[] = ['loseNextResponse', 'reloadMidNextRound', 'holdNextEndRound', 'releaseHeld'];

/** Поле ввода → значение настройки: целое в пределах поля, проценты — долей; не число — null. */
function settingOf(field: Field, raw: string): number | null {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) return null;
  const clamped = Math.min(field.max, Math.max(0, Math.round(value)));
  return field.percent ? clamped / 100 : clamped;
}

function shown(field: Field, settings: LabSettings): string {
  const value = settings[field.key];
  return String(field.percent ? Math.round(value * 100) : value);
}

export function LabDialog({ services, onClose, returnFocus }: DialogProps) {
  const { dict } = useLanguage();
  const text = dict.lab;
  const ids = useId();
  const lab = services.lab;
  const [settings, setSettings] = useState<LabSettings>(lab.settings);
  const [done, setDone] = useState<string | null>(null);
  const apply = (next: Partial<LabSettings>): void => {
    lab.set(next);
    setSettings(lab.settings);
  };
  return (
    <Modal name="lab" title={dict.text.lab} closeLabel={dict.text.close} onClose={onClose} returnFocus={returnFocus}>
      <p className="muted">{text.intro}</p>
      <div className="lab-grid">
        {FIELDS.map((field, index) => (
          <label key={field.key} className="lab-field" htmlFor={`${ids}-${field.key}`}>
            <span className="label-line">{text.fields[field.key]}</span>
            <input
              id={`${ids}-${field.key}`}
              className="text-input"
              type="number"
              min={0}
              max={field.max}
              step={field.step}
              value={shown(field, settings)}
              data-autofocus={index === 0 ? '' : undefined}
              onChange={(event) => {
                const value = settingOf(field, event.target.value);
                if (value !== null) apply({ [field.key]: value });
              }}
            />
          </label>
        ))}
      </div>
      <div className="row">
        <button
          type="button"
          className="action"
          onClick={() => {
            apply(CLEAR);
            setDone(text.cleared);
          }}
        >
          {text.clear}
        </button>
      </div>
      <h3 className="field-title">{text.actionsTitle}</h3>
      <div className="lab-actions">
        {ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            className="action"
            onClick={() => {
              lab[action]();
              setDone(text.done[action]);
            }}
          >
            {text.actions[action]}
          </button>
        ))}
      </div>
      {done !== null && (
        <p className="field-hint" role="status" data-testid="lab-status">
          {done}
        </p>
      )}
    </Modal>
  );
}
