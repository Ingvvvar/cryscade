// Правила и выплаты (§11, решение 3 фазы 7): строятся из данных модели — конфига игры, тот же объект, что у сервера в
// воркере; таблица 7 × 6 — множители ставки по полосам размеров. Ленивый модуль (LAZY_MODULES гейта сборки).

import { DEFAULT_CONFIG } from '../../core/model/config.ts';
import { SPOT_MAX_LEVEL } from '../../core/model/grid.ts';
import { useLanguage } from '../language-context.ts';
import { multiplier } from './format.ts';
import { Modal } from './modal.tsx';
import type { DialogProps } from './services.ts';

/** Полосы размеров: «5–6», …, последняя открыта сверху — «15+». */
function bandLabels(bands: readonly number[]): string[] {
  return bands.map((from, index) => {
    const next = bands[index + 1];
    return next === undefined ? `${String(from)}+` : `${String(from)}–${String(next - 1)}`;
  });
}

export function RulesDialog({ onClose, returnFocus }: DialogProps) {
  const { dict } = useLanguage();
  const config = DEFAULT_CONFIG;
  const rules = dict.rules;
  const steps = config.freeSpinsByScatters.flatMap((spins, cores) => (spins > 0 ? [{ cores, spins }] : []));
  const last = steps.length - 1;
  const feature = steps.map((step, index) => `${index === last ? rules.orMore(step.cores) : String(step.cores)} — ${String(step.spins)}`).join(', ');
  const cap = new Intl.NumberFormat(dict.locale).format(config.capX100 / 100);
  return (
    <Modal name="rules" title={dict.text.rules} closeLabel={dict.text.close} onClose={onClose} returnFocus={returnFocus}>
      <div className="rules" data-autofocus="" tabIndex={-1}>
        <p>{rules.clusters(config.clusterMin)}</p>
        <p>{rules.cascades}</p>
        <p>{rules.spots(2 ** (SPOT_MAX_LEVEL - 1))}</p>
        <p>{rules.feature(feature)}</p>
        <p>{rules.retrigger(config.retrigger.min, config.retrigger.add)}</p>
        <p>{rules.cap(cap)}</p>
        <p>{rules.rtp}</p>
      </div>
      <table className="paytable" data-testid="paytable">
        <caption>{rules.table}</caption>
        <thead>
          <tr>
            <th scope="col">{rules.symbol}</th>
            {bandLabels(config.sizeBands).map((band) => (
              <th key={band} scope="col">
                {band}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {config.paytableX100.map((row, symbol) => (
            <tr key={rules.symbols[symbol]}>
              <th scope="row">{rules.symbols[symbol]}</th>
              {row.map((pay, band) => (
                <td key={config.sizeBands[band]}>{multiplier(pay, dict.locale)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
