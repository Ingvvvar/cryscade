// Честность (§7, §11): обязательство, сид игрока и следующий nonce — до игры; смена сида и новый секрет раскрывают
// прежний секрет. Панель «Перевірити»: секрет, сид и nonce → пересчёт выбора (verify) → совпадение с раундом истории
// с тем же обязательством и nonce. Независимая проверка без игры — docs/fairness.md. Ленивый модуль (LAZY_MODULES).

import { useEffect, useId, useState } from 'react';
import type { CallOutcome } from '../../client/index.ts';
import type { FairnessView, SeedResult } from '../../protocol/index.ts';
import { useLanguage } from '../language-context.ts';
import { multiplier, roundTime } from './format.ts';
import { Modal } from './modal.tsx';
import type { Dictionary } from '../i18n/dictionary.ts';
import type { DialogProps, FairnessControl } from './services.ts';

const SEED = /^[0-9A-Za-z]{1,64}$/;
const SECRET = /^[0-9a-f]{64}$/;
const NONCE = /^(0|[1-9]\d{0,15})$/;

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ready'; readonly view: FairnessView | null };

/** Отправка формы: только чтобы браузер не перезагрузил страницу. */
interface Submit {
  preventDefault(): void;
}

/** Введённое в панель проверки — годится или текст ошибки. */
function inputProblem(dict: Dictionary, secret: string, seed: string, nonce: string): string | null {
  if (!SECRET.test(secret)) return dict.fairness.badSecret;
  if (!SEED.test(seed)) return dict.fairness.badSeed;
  return NONCE.test(nonce) && Number.isSafeInteger(Number(nonce)) ? null : dict.fairness.badNonce;
}

/** Пересчёт и сверка с историей: обязательство, запись книги и выплата — и раунд с тем же обязательством и nonce. */
async function verifyLines(fairness: FairnessControl, dict: Dictionary, secret: string, seed: string, nonce: number): Promise<string[]> {
  const text = dict.fairness;
  const outcome = await fairness.verify(secret, seed, nonce);
  if (outcome.kind !== 'ok') return [dict.text.failed];
  const result = outcome.result;
  const lines = [`${text.commitment}: ${result.commitment}`, text.result(result.bookIndex, multiplier(result.payX100, dict.locale))];
  const history = await fairness.history(100);
  if (history.kind !== 'ok') return [...lines, dict.text.failed];
  const round = history.result.rounds.find((entry) => entry.commitment === result.commitment && entry.nonce === nonce);
  if (round === undefined) return [...lines, text.notFound];
  const time = roundTime(round.createdAt, dict.locale);
  return [...lines, round.bookIndex === result.bookIndex && round.payX100 === result.payX100 ? text.foundMatch(time) : text.foundMismatch(time)];
}

export function FairnessDialog({ services, onClose, returnFocus }: DialogProps) {
  const { dict } = useLanguage();
  const text = dict.fairness;
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [seed, setSeed] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [secretInput, setSecretInput] = useState('');
  const [seedInput, setSeedInput] = useState('');
  const [nonceInput, setNonceInput] = useState('0');
  const [verdict, setVerdict] = useState<readonly string[]>([]);

  useEffect(() => {
    let live = true;
    void services.fairness.fairness().then((outcome) => {
      if (!live) return;
      if (outcome.kind !== 'ok') {
        setLoaded({ kind: 'failed' });
        return;
      }
      setLoaded({ kind: 'ready', view: outcome.result });
      setSeed(outcome.result?.clientSeed ?? '');
    });
    return () => {
      live = false;
    };
  }, [services]);

  /** Смена сида или секрета: прежний секрет раскрыт — он и прежний сид идут в панель проверки. */
  const changed = (outcome: CallOutcome<SeedResult>, previousSeed: string): void => {
    if (outcome.kind === 'ok') {
      setLoaded({ kind: 'ready', view: outcome.result.fairness });
      setSeed(outcome.result.fairness.clientSeed);
      setRevealed(outcome.result.revealed.secret);
      setSecretInput(outcome.result.revealed.secret);
      setSeedInput(previousSeed);
      setMessage(null);
      return;
    }
    setMessage(outcome.kind === 'rejected' && outcome.error.code === 'ROUND_ACTIVE' ? text.roundActive : dict.text.failed);
  };

  const changeSeed = (event: Submit): void => {
    event.preventDefault();
    if (!SEED.test(seed)) {
      setMessage(text.badSeed);
      return;
    }
    const previous = loaded.kind === 'ready' ? (loaded.view?.clientSeed ?? seed) : seed;
    void services.fairness.setClientSeed(seed).then((outcome) => {
      changed(outcome, previous);
    });
  };

  const rotate = (): void => {
    const previous = loaded.kind === 'ready' ? (loaded.view?.clientSeed ?? seed) : seed;
    void services.fairness.rotateSeed().then((outcome) => {
      changed(outcome, previous);
    });
  };

  const verify = (event: Submit): void => {
    event.preventDefault();
    const problem = inputProblem(dict, secretInput, seedInput, nonceInput);
    if (problem !== null) {
      setVerdict([problem]);
      return;
    }
    void verifyLines(services.fairness, dict, secretInput, seedInput, Number(nonceInput)).then(setVerdict);
  };

  return (
    <Modal name="fairness" title={dict.text.fairness} closeLabel={dict.text.close} onClose={onClose} returnFocus={returnFocus}>
      {loaded.kind === 'loading' && <p className="muted">{dict.text.loading}</p>}
      {loaded.kind === 'failed' && <p className="muted">{dict.text.failed}</p>}
      {loaded.kind === 'ready' && loaded.view === null && <p className="muted">{text.replayOnly}</p>}
      {loaded.kind === 'ready' && loaded.view !== null && (
        <>
          <dl className="facts">
            <dt>{text.commitment}</dt>
            <dd className="hex" data-testid="commitment">
              {loaded.view.commitment}
            </dd>
            <dt>{text.nonce}</dt>
            <dd data-testid="nonce">{loaded.view.nonce}</dd>
          </dl>
          <form className="field" onSubmit={changeSeed}>
            <label className="field-title" htmlFor={`${ids}-seed`}>
              {text.clientSeed}
            </label>
            <div className="row">
              <input
                id={`${ids}-seed`}
                className="text-input"
                value={seed}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                data-autofocus=""
                onChange={(event) => {
                  setSeed(event.target.value);
                }}
              />
              <button type="submit" className="action">
                {text.changeSeed}
              </button>
            </div>
            <p className="field-hint">{text.seedHint}</p>
          </form>
          <div className="row">
            <button type="button" className="action" onClick={rotate}>
              {text.rotate}
            </button>
          </div>
          {message !== null && (
            <p className="field-hint" role="status">
              {message}
            </p>
          )}
          {revealed !== null && (
            <dl className="facts">
              <dt>{text.revealed}</dt>
              <dd className="hex" data-testid="revealed">
                {revealed}
              </dd>
            </dl>
          )}
        </>
      )}
      <form className="field verify" onSubmit={verify}>
        <h3 className="field-title">{text.verify}</h3>
        <label className="label-line" htmlFor={`${ids}-secret`}>
          {text.secret}
        </label>
        <input
          id={`${ids}-secret`}
          className="text-input hex"
          value={secretInput}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setSecretInput(event.target.value.trim().toLowerCase());
          }}
        />
        <label className="label-line" htmlFor={`${ids}-verify-seed`}>
          {text.clientSeed}
        </label>
        <input
          id={`${ids}-verify-seed`}
          className="text-input"
          value={seedInput}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setSeedInput(event.target.value.trim());
          }}
        />
        <label className="label-line" htmlFor={`${ids}-nonce`}>
          nonce
        </label>
        <input
          id={`${ids}-nonce`}
          className="text-input"
          value={nonceInput}
          inputMode="numeric"
          autoComplete="off"
          onChange={(event) => {
            setNonceInput(event.target.value.trim());
          }}
        />
        <div className="row">
          <button type="submit" className="action">
            {text.verify}
          </button>
        </div>
        {verdict.length > 0 && (
          <div className="verdict-lines" role="status" data-testid="verify-result">
            {verdict.map((line) => (
              <p key={line} className={line.startsWith(`${text.commitment}:`) ? 'hex' : undefined}>
                {line}
              </p>
            ))}
          </div>
        )}
      </form>
    </Modal>
  );
}
