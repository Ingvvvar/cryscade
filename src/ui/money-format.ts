// Сумма в кредитах из минимальных единиц (§4.6): целая часть и копейки считаются целыми, без деления с плавающей
// точкой — у больших сумм оно теряет копейки (…408,99 выходит …408,98). Разряды — по локали, у украинской
// разделитель групп — неразрывный пробел, дробная часть — через запятую. С фазы 7 локаль выберет игрок.

export class MoneyFormat {
  readonly #whole: Intl.NumberFormat;
  readonly #decimal: string;

  constructor(locale: string) {
    this.#whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    this.#decimal = new Intl.NumberFormat(locale).formatToParts(0.5).find((part) => part.type === 'decimal')?.value ?? '.';
  }

  /** 99 935 → «999,35»; −0 и отрицательные сюда не приходят: баланс и выигрыш — натуральные. */
  format(minor: number): string {
    const cents = minor % 100;
    const whole = (minor - cents) / 100;
    return `${this.#whole.format(whole)}${this.#decimal}${String(cents).padStart(2, '0')}`;
  }
}
