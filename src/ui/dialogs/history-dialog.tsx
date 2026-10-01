// История (§7, §11): последние 100 раундов — время, ставка, выигрыш, запись книги, nonce. «Перевірити» — у раунда книги с
// раскрытым секретом: пересчёт выбора (verify) обязан дать то же обязательство, ту же запись и ту же выплату.
// «Відтворити» — ссылка повтора ?replay=round:<id>. Ленивый модуль (LAZY_MODULES гейта сборки).

import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../protocol/index.ts';
import { useLanguage } from '../language-context.ts';
import { roundTime } from './format.ts';
import { Modal } from './modal.tsx';
import type { DialogProps, FairnessControl } from './services.ts';

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'failed' } | { readonly kind: 'ready'; readonly rounds: readonly HistoryEntry[] };
type Check = 'match' | 'mismatch' | 'failed';

/** Пересчёт раунда истории: обязательство, запись и выплата — те же; нет ответа — failed. */
async function checkRound(fairness: FairnessControl, entry: HistoryEntry): Promise<Check> {
  if (entry.secret === null || entry.clientSeed === null || entry.nonce === null) return 'failed';
  const outcome = await fairness.verify(entry.secret, entry.clientSeed, entry.nonce);
  if (outcome.kind !== 'ok') return 'failed';
  const { commitment, bookIndex, payX100 } = outcome.result;
  return commitment === entry.commitment && bookIndex === entry.bookIndex && payX100 === entry.payX100 ? 'match' : 'mismatch';
}

export function HistoryDialog({ services, onClose, returnFocus }: DialogProps) {
  const { dict, money } = useLanguage();
  const text = dict.history;
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [checks, setChecks] = useState<ReadonlyMap<string, Check>>(new Map());
  useEffect(() => {
    let live = true;
    void services.fairness.history(100).then((outcome) => {
      if (live) setLoaded(outcome.kind === 'ok' ? { kind: 'ready', rounds: outcome.result.rounds } : { kind: 'failed' });
    });
    return () => {
      live = false;
    };
  }, [services]);
  const check = (entry: HistoryEntry): void => {
    void checkRound(services.fairness, entry).then((result) => {
      setChecks((current) => new Map(current).set(entry.roundId, result));
    });
  };
  const verdict = (entry: HistoryEntry) => {
    if (entry.source === 'live') return <span className="muted">{text.live}</span>;
    if (entry.source === 'forced') return <span className="muted">{text.forced}</span>;
    if (entry.secret === null) return <span className="muted">{text.hidden}</span>;
    const result = checks.get(entry.roundId);
    if (result === undefined) {
      return (
        <button
          type="button"
          className="inline-action"
          onClick={() => {
            check(entry);
          }}
        >
          {text.check}
        </button>
      );
    }
    if (result === 'failed') return <span className="muted">{dict.text.failed}</span>;
    return <span className={result === 'match' ? 'verdict verdict-ok' : 'verdict verdict-bad'}>{result === 'match' ? text.match : text.mismatch}</span>;
  };
  return (
    <Modal name="history" title={dict.text.history} closeLabel={dict.text.close} onClose={onClose} returnFocus={returnFocus}>
      {loaded.kind === 'loading' && <p className="muted">{dict.text.loading}</p>}
      {loaded.kind === 'failed' && <p className="muted">{dict.text.failed}</p>}
      {loaded.kind === 'ready' && loaded.rounds.length === 0 && <p className="muted">{text.empty}</p>}
      {loaded.kind === 'ready' && loaded.rounds.length > 0 && (
        <div className="table-scroll" data-autofocus="" tabIndex={-1}>
          <table className="history" data-testid="history">
            <thead>
              <tr>
                <th scope="col">{text.time}</th>
                <th scope="col">{text.bet}</th>
                <th scope="col">{text.win}</th>
                <th scope="col">{text.book}</th>
                <th scope="col">{text.nonce}</th>
                <th scope="col">{text.check}</th>
                <th scope="col">{text.replay}</th>
              </tr>
            </thead>
            <tbody>
              {loaded.rounds.map((entry) => (
                <tr key={entry.roundId} data-round={entry.roundId}>
                  <td>{roundTime(entry.createdAt, dict.locale)}</td>
                  <td>{money.format(entry.betMinor)}</td>
                  <td>{money.format(entry.winMinor)}</td>
                  <td>{entry.bookIndex ?? '—'}</td>
                  <td>{entry.nonce ?? '—'}</td>
                  <td>{verdict(entry)}</td>
                  <td>
                    <a className="inline-action" href={`?replay=round:${entry.roundId}`}>
                      {text.replay}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
