// Сумма в кредитах из минимальных единиц (§4.6): целая часть и копейки считаются целыми, без деления с плавающей
// точкой — у больших сумм оно теряет копейки (…408,99 выходит …408,98). Разряды — по локали, у украинской
// разделитель групп — неразрывный пробел, дробная часть — через запятую. С фазы 7 локаль выберет игрок.
// Те же разделители и порог группировки уходят в рендер (style): счётчики Pixi раскладывают суммы сами, без строк.

import type { NumberStyle } from '../render/number-layout.ts';

export class MoneyFormat {
  readonly #whole: Intl.NumberFormat;
  readonly #decimal: string;
  /** Разделители и порог группировки локали — для счётчиков Pixi. */
  readonly style: NumberStyle;

  constructor(locale: string) {
    this.#whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    this.#decimal = new Intl.NumberFormat(locale).formatToParts(0.5).find((part) => part.type === 'decimal')?.value ?? '.';
    // Порог группировки — по локали: у pl-PL «1000», но «10 000» (минимум группировки 2).
    const grouped = (value: number): string | undefined => this.#whole.formatToParts(value).find((part) => part.type === 'group')?.value;
    const at1000 = grouped(1000);
    const at10000 = grouped(10_000);
    this.style = {
      group: at1000 ?? at10000 ?? ' ',
      decimal: this.#decimal,
      groupFrom: at1000 !== undefined ? 1000 : at10000 !== undefined ? 10_000 : Number.MAX_SAFE_INTEGER,
    };
  }

  /** 99 935 → «999,35»; −0 и отрицательные сюда не приходят: баланс и выигрыш — натуральные. */
  format(minor: number): string {
    const cents = minor % 100;
    const whole = (minor - cents) / 100;
    return `${this.#whole.format(whole)}${this.#decimal}${String(cents).padStart(2, '0')}`;
  }
}
