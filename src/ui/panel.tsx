// Панель (§9, §11): муляж фазы 3 ожил. Зоны — те же, по которым Pixi ставит сетку: раскладка одна на обоих. Оверлей над
// живой сценой пропускает тап на канвас; кнопкам — pointer-events: auto. Число выигрыша рисует Pixi в зоне winValue,
// здесь — только подпись в winLabel. Кнопки игры работают в покое; при закрытом хранилище — нигде.

import type { CSSProperties, ReactNode } from 'react';
import type { ControllerSnapshot } from '../client/index.ts';
import { toScreen, type Layout, type ZoneName } from '../render/layout.ts';
import type { Game } from './game.ts';
import type { MoneyFormat } from './money-format.ts';
import type { PreferencesView } from './presentation-preferences.ts';
import { TEXT } from './texts.ts';

interface ZoneProps {
  readonly layout: Layout;
  readonly name: ZoneName;
  readonly children: ReactNode;
}

function Zone({ layout, name, children }: ZoneProps) {
  const rect = toScreen(layout, layout.design.zones[name]);
  return (
    <div className={`zone zone-${name}`} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      {children}
    </div>
  );
}

export interface PanelProps {
  readonly layout: Layout;
  readonly game: Game;
  readonly snapshot: ControllerSnapshot;
  readonly turbo: PreferencesView;
  readonly onTurbo: () => void;
  readonly money: MoneyFormat;
}

/** Идёт показ раунда: «Спін» — пропуск или «продолжить» на плашке фриспинов. */
function showing(state: ControllerSnapshot['state']): boolean {
  return state.name === 'presenting' || state.name === 'featureIntro' || (state.name === 'restoring' && state.stage === 'show');
}

export function Panel({ layout, game, snapshot, turbo, onTurbo, money }: PanelProps) {
  const style = { '--u': `${String(layout.scale)}px` } as CSSProperties;
  const playable = snapshot.state.name === 'idle' && snapshot.notice !== 'versionchange';
  const presenting = showing(snapshot.state);
  return (
    <div className={`panel panel-${layout.orientation}`} style={style}>
      <Zone layout={layout} name="top">
        <button type="button" className="icon" aria-label={TEXT.menu}>
          ☰
        </button>
        <h1 className="title">Cryscade</h1>
        <button type="button" className="icon" aria-label={TEXT.sound}>
          ♪
        </button>
      </Zone>
      <Zone layout={layout} name="winLabel">
        <span className="label label-warm">{TEXT.win}</span>
      </Zone>
      <Zone layout={layout} name="balance">
        <span className="label">{TEXT.balance}</span>
        <output className="value" data-testid="balance">
          {snapshot.balanceMinor === null ? '—' : money.format(snapshot.balanceMinor)}
        </output>
        <button
          type="button"
          className="refill"
          disabled={!playable}
          onClick={() => {
            game.refill();
          }}
        >
          {TEXT.refill}
        </button>
      </Zone>
      <Zone layout={layout} name="betDown">
        <button
          type="button"
          className="step"
          aria-label={TEXT.betDown}
          disabled={!playable}
          onClick={() => {
            game.betDown();
          }}
        >
          −
        </button>
      </Zone>
      <Zone layout={layout} name="spin">
        <button
          type="button"
          className="spin"
          disabled={!playable && !presenting}
          aria-busy={snapshot.state.name !== 'idle'}
          onClick={() => {
            if (presenting) game.tap();
            else game.spin();
          }}
        >
          {TEXT.spin}
        </button>
      </Zone>
      <Zone layout={layout} name="betUp">
        <button
          type="button"
          className="step"
          aria-label={TEXT.betUp}
          disabled={!playable}
          onClick={() => {
            game.betUp();
          }}
        >
          +
        </button>
      </Zone>
      <Zone layout={layout} name="betValue">
        <span className="label">{TEXT.bet}</span>
        <output className="value" data-testid="bet">
          {snapshot.betMinor === null ? '—' : money.format(snapshot.betMinor)}
        </output>
      </Zone>
      <Zone layout={layout} name="toggles">
        <button type="button" className="toggle" aria-pressed={turbo.turbo} disabled={!turbo.turboAllowed} onClick={onTurbo}>
          {TEXT.turbo}
        </button>
        <button type="button" className="toggle">
          {TEXT.auto}
        </button>
      </Zone>
    </div>
  );
}
