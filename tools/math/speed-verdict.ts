// Решение замера скорости по нагрузке стенда. Чистая функция: число пишется, только если средняя нагрузка
// за минуту не выше порога и до замера, и после; иначе — «стенд занят» с цифрами, без числа.

export interface Load {
  readonly before: number;
  readonly after: number;
  readonly threshold: number;
}

export interface Speed {
  readonly silentPerCore: number;
  readonly statsPerCore: number;
}

export type Verdict = { readonly measured: true; readonly text: string } | { readonly measured: false; readonly text: string };

const rate = (value: number): string => Math.round(value).toLocaleString('ru-RU');

export function verdict(load: Load, speed: Speed | null, environment: string): Verdict {
  const loads = `нагрузка ${load.before.toFixed(2)} до и ${Number.isNaN(load.after) ? '—' : load.after.toFixed(2)} после при пороге ${load.threshold.toFixed(2)}`;
  if (speed === null || load.before > load.threshold || !(load.after <= load.threshold)) {
    return {
      measured: false,
      text: `Стенд занят: ${loads} — число не записано. Перезапустить \`npm run math:speed\` на свободной машине.`,
    };
  }
  return {
    measured: true,
    text:
      `${environment} Одно ядро, худший из 5 замеров по 2·10⁵ раундов после прогрева: тихий режим ${rate(speed.silentPerCore)} раундов/с, ` +
      `путь симулятора (StatsRecorder и сборщик) ${rate(speed.statsPerCore)} раундов/с; ${loads}.`,
  };
}
