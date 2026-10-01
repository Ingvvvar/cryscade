// Панель (§9, §11): муляж фазы 3 ожил. Зоны — те же, по которым Pixi ставит сетку: раскладка одна на обоих. Оверлей над
// живой сценой пропускает тап на канвас; кнопкам — pointer-events: auto. Число выигрыша рисует Pixi в зоне winValue,
// здесь — только подпись в winLabel. Кнопки игры работают в покое; при закрытом хранилище — нигде.

import { useId, useRef, type CSSProperties, type ReactNode } from 'react';
import type { ControllerSnapshot } from '../client/index.ts';
import { toScreen, type Layout, type ZoneName } from '../render/layout.ts';
import type { DialogName } from './dialog-host.tsx';
import type { ExternalSource } from './external.ts';
import type { Game } from './game.ts';
import { useLanguage } from './language-context.ts';
import type { PreferencesView } from './presentation-preferences.ts';
import type { SessionView } from './session.ts';
import { SessionStrip } from './session-strip.tsx';

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
  readonly session: ExternalSource<SessionView>;
  readonly now: () => number;
  /** Открыть диалог; фокус по закрытии вернётся на returnFocus. */
  readonly onOpenDialog: (name: DialogName, returnFocus: HTMLElement | null) => void;
}

/** Пункты меню — диалоги по порядку. */
const MENU: readonly DialogName[] = ['rules', 'settings', 'history', 'fairness'];

/** Меню (§11): popover с диалогами; в обычном пресете — и сессия. Фокус по закрытии диалога — на кнопку меню. */
function Menu({ session, now, sessionInMenu, onOpenDialog }: Pick<PanelProps, 'session' | 'now' | 'onOpenDialog'> & { readonly sessionInMenu: boolean }) {
  const { dict } = useLanguage();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = (name: DialogName): void => {
    menuRef.current?.hidePopover();
    onOpenDialog(name, buttonRef.current);
  };
  return (
    <>
      <button ref={buttonRef} type="button" className="icon" aria-label={dict.text.menu} popoverTarget={id}>
        ☰
      </button>
      <div ref={menuRef} id={id} popover="auto" className="menu" data-testid="menu">
        {MENU.map((name) => (
          <button
            key={name}
            type="button"
            className="menu-item"
            onClick={() => {
              open(name);
            }}
          >
            {dict.text[name]}
          </button>
        ))}
        {sessionInMenu && (
          <section className="menu-session" aria-label={dict.text.session}>
            <h2 className="menu-title">{dict.text.session}</h2>
            <SessionStrip session={session} now={now} className="session session-menu" />
          </section>
        )}
      </div>
    </>
  );
}

/** Идёт показ раунда: «Спін» — пропуск или «продолжить» на плашке фриспинов. */
function showing(state: ControllerSnapshot['state']): boolean {
  return state.name === 'presenting' || state.name === 'featureIntro' || (state.name === 'restoring' && state.stage === 'show');
}

/**
 * Ставка и её выбор (§11): число — кнопка, popover со всеми уровнями конфига. Выбор закрывает popover и возвращает
 * фокус на кнопку ставки сам (WebKit его не возвращает). Вне покоя кнопка выключена — popover не открыть.
 */
function BetChoice({ game, snapshot, playable }: { readonly game: Game; readonly snapshot: ControllerSnapshot; readonly playable: boolean }) {
  const { dict, money } = useLanguage();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const levelsRef = useRef<HTMLDivElement>(null);
  const bet = snapshot.betMinor === null ? '—' : money.format(snapshot.betMinor);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="value bet-value"
        popoverTarget={id}
        disabled={!playable}
        aria-label={`${dict.text.chooseBet}: ${bet}`}
        data-testid="bet"
      >
        {bet}
      </button>
      <div ref={levelsRef} id={id} popover="auto" className="levels" data-testid="bet-levels">
        <p className="levels-title">{dict.text.chooseBet}</p>
        <div className="levels-grid">
          {snapshot.betLevelsMinor.map((level) => (
            <button
              key={level}
              type="button"
              className="level"
              aria-pressed={level === snapshot.betMinor}
              onClick={() => {
                game.setBet(level);
                levelsRef.current?.hidePopover();
                buttonRef.current?.focus();
              }}
            >
              {money.format(level)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function Panel({ layout, game, snapshot, turbo, onTurbo, session, now, onOpenDialog }: PanelProps) {
  const { dict, money } = useLanguage();
  const text = dict.text;
  const style = { '--u': `${String(layout.scale)}px` } as CSSProperties;
  const playable = snapshot.state.name === 'idle' && snapshot.notice !== 'versionchange';
  const presenting = showing(snapshot.state);
  const sessionOnScreen = turbo.preset.sessionAlwaysVisible;
  return (
    <div className={`panel panel-${layout.orientation}`} style={style}>
      <Zone layout={layout} name="top">
        <Menu session={session} now={now} sessionInMenu={!sessionOnScreen} onOpenDialog={onOpenDialog} />
        {sessionOnScreen ? <SessionStrip session={session} now={now} className="session session-top" /> : <h1 className="title">Cryscade</h1>}
        <button type="button" className="icon" aria-label={text.sound}>
          ♪
        </button>
      </Zone>
      <Zone layout={layout} name="winLabel">
        <span className="label label-warm">{text.win}</span>
      </Zone>
      <Zone layout={layout} name="balance">
        <span className="label">{text.balance}</span>
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
          {text.refill}
        </button>
      </Zone>
      <Zone layout={layout} name="betDown">
        <button
          type="button"
          className="step"
          aria-label={text.betDown}
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
          {text.spin}
        </button>
      </Zone>
      <Zone layout={layout} name="betUp">
        <button
          type="button"
          className="step"
          aria-label={text.betUp}
          disabled={!playable}
          onClick={() => {
            game.betUp();
          }}
        >
          +
        </button>
      </Zone>
      <Zone layout={layout} name="betValue">
        <span className="label">{text.bet}</span>
        <BetChoice game={game} snapshot={snapshot} playable={playable} />
      </Zone>
      <Zone layout={layout} name="toggles">
        <button type="button" className="toggle" aria-pressed={turbo.turbo} disabled={!turbo.preset.turbo} onClick={onTurbo}>
          {text.turbo}
        </button>
        <button type="button" className="toggle">
          {text.auto}
        </button>
      </Zone>
    </div>
  );
}
