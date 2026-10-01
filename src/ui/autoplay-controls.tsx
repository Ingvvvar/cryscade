// Автоигра в панели (§11, решение 4 фазы 7): кнопка «Авто» открывает popover настроек серии — 10 / 25 / 50 / 100 спинов,
// лимит потерь в ставках (обязателен, по умолчанию 10), остановка на фриспинах (по умолчанию да) и на выигрыше от N×
// (по выбору); идёт серия — та же кнопка её останавливает. В строгом пресете кнопка выключена. Полоса серии — ход и
// причина остановки — над сценой, рядом с прочими полосами.

import { useId, useRef, useState } from 'react';
import { AUTOPLAY_COUNTS, DEFAULT_AUTOPLAY, type AutoplayCount, type AutoplayOptions, type AutoplayView } from './autoplay.ts';
import type { ExternalSource } from './external.ts';
import { useExternal } from './external.ts';
import { useLanguage } from './language-context.ts';

/** Что панели нужно от автоигры: снимок серии и действия игрока. */
export interface AutoplayControl extends ExternalSource<AutoplayView> {
  start(options: AutoplayOptions): void;
  stop(): void;
  dismiss(): void;
}

/** Выигрыш от N× по умолчанию, когда игрок включает эту остановку. */
const DEFAULT_WIN_X = 50;

function whole(raw: string, min: number, max: number): number | null {
  const value = Number(raw);
  return raw.trim() !== '' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function AutoButton({ autoplay, allowed, playable }: { readonly autoplay: AutoplayControl; readonly allowed: boolean; readonly playable: boolean }) {
  const { dict } = useLanguage();
  const text = dict.autoplay;
  const view = useExternal(autoplay);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<AutoplayCount>(DEFAULT_AUTOPLAY.count);
  const [lossLimit, setLossLimit] = useState(String(DEFAULT_AUTOPLAY.lossLimitBets));
  const [stopOnFeature, setStopOnFeature] = useState(DEFAULT_AUTOPLAY.stopOnFeature);
  const [stopOnWin, setStopOnWin] = useState(false);
  const [winX, setWinX] = useState(String(DEFAULT_WIN_X));
  const limit = whole(lossLimit, 1, 1000);
  const win = stopOnWin ? whole(winX, 1, 5000) : null;
  const ready = limit !== null && (!stopOnWin || win !== null);
  if (view.kind === 'running') {
    return (
      <button
        type="button"
        className="toggle"
        aria-pressed="true"
        onClick={() => {
          autoplay.stop();
        }}
      >
        {text.stop}
      </button>
    );
  }
  return (
    <>
      <button ref={buttonRef} type="button" className="toggle" disabled={!allowed || !playable} popoverTarget={id}>
        {dict.text.auto}
      </button>
      <div ref={formRef} id={id} popover="auto" className="levels autoplay" data-testid="autoplay">
        <p className="levels-title">{text.title}</p>
        <fieldset className="field">
          <legend className="label-line">{text.count}</legend>
          <div className="levels-grid">
            {AUTOPLAY_COUNTS.map((option) => (
              <button
                key={option}
                type="button"
                className="level"
                aria-pressed={option === count}
                onClick={() => {
                  setCount(option);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="lab-field">
          <span className="label-line">{text.lossLimit}</span>
          <input
            className="text-input"
            type="number"
            min={1}
            max={1000}
            required
            value={lossLimit}
            onChange={(event) => {
              setLossLimit(event.target.value);
            }}
          />
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={stopOnFeature}
            onChange={(event) => {
              setStopOnFeature(event.target.checked);
            }}
          />
          <span>{text.stopOnFeature}</span>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={stopOnWin}
            onChange={(event) => {
              setStopOnWin(event.target.checked);
            }}
          />
          <span>{text.stopOnWin}</span>
        </label>
        <input
          className="text-input"
          type="number"
          min={1}
          max={5000}
          aria-label={text.stopOnWin}
          disabled={!stopOnWin}
          value={winX}
          onChange={(event) => {
            setWinX(event.target.value);
          }}
        />
        <button
          type="button"
          className="action autoplay-start"
          disabled={!ready}
          onClick={() => {
            if (limit === null) return;
            formRef.current?.hidePopover();
            buttonRef.current?.focus();
            autoplay.start({ count, lossLimitBets: limit, stopOnFeature, stopOnWinX: win });
          }}
        >
          {text.start}
        </button>
      </div>
    </>
  );
}

/** Полоса серии: ход и «Стоп» — пока идёт; причина остановки и «Сховати» — после. */
export function AutoplayBar({ autoplay }: { readonly autoplay: AutoplayControl }) {
  const { dict } = useLanguage();
  const text = dict.autoplay;
  const view = useExternal(autoplay);
  if (view.kind === 'off') return null;
  return (
    <p className="notice notice-autoplay" data-notice="autoplay" data-testid="autoplay-bar">
      {view.kind === 'running' ? text.left(view.left) : text.stopped[view.reason]}
      <button
        type="button"
        className="notice-link"
        onClick={() => {
          if (view.kind === 'running') autoplay.stop();
          else autoplay.dismiss();
        }}
      >
        {view.kind === 'running' ? text.stop : text.dismiss}
      </button>
    </p>
  );
}
