// Муляж панели (§15, фаза 3): статичная разметка по зонам §9 с настоящими шрифтами и палитрой, без логики.
// Не выбрасывается — в фазе 4 становится минимальной панелью. Зоны — те же, по которым Pixi ставит сетку:
// раскладка одна на обоих. Оверлей над живой сценой пропускает тап на канвас; кнопкам — pointer-events: auto (§11).
// Число выигрыша рисует Pixi в зоне winValue (§11), здесь — только подпись в winLabel.

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { toScreen, type Layout, type ZoneName } from '../render/layout.ts';

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

export function PanelMock({ layout }: { readonly layout: Layout }) {
  const money = useMemo(() => new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), []);
  const style = { '--u': `${String(layout.scale)}px` } as CSSProperties;
  return (
    <div className={`panel panel-${layout.orientation}`} style={style}>
      <Zone layout={layout} name="top">
        <button type="button" className="icon" aria-label="Меню">
          ☰
        </button>
        <h1 className="title">Cryscade</h1>
        <button type="button" className="icon" aria-label="Звук">
          ♪
        </button>
      </Zone>
      <Zone layout={layout} name="winLabel">
        <span className="label label-warm">Виграш</span>
      </Zone>
      <Zone layout={layout} name="balance">
        <span className="label">Баланс</span>
        <span className="value">{money.format(1000)}</span>
      </Zone>
      <Zone layout={layout} name="betDown">
        <button type="button" className="step" aria-label="Зменшити ставку">
          −
        </button>
      </Zone>
      <Zone layout={layout} name="spin">
        <button type="button" className="spin">
          Спін
        </button>
      </Zone>
      <Zone layout={layout} name="betUp">
        <button type="button" className="step" aria-label="Збільшити ставку">
          +
        </button>
      </Zone>
      <Zone layout={layout} name="betValue">
        <span className="label">Ставка</span>
        <span className="value">{money.format(1)}</span>
      </Zone>
      <Zone layout={layout} name="toggles">
        <button type="button" className="toggle">
          Турбо
        </button>
        <button type="button" className="toggle">
          Авто
        </button>
      </Zone>
    </div>
  );
}
