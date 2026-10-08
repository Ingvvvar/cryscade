// Решение замера скорости по нагрузке стенда. Порог относительный: средняя нагрузка за минуту не выше 0.4 × число
// логических ядер. Число пишется, только если нагрузка не выше порога и до замера, и после; иначе — «стенд занят»
// с цифрами, без числа. До отказа замер ждёт, пока нагрузка спадёт: хвост своего же прогона держит среднюю
// за минуту ещё несколько минут.

/** Доля логических ядер, до которой стенд считается свободным. */
const LOAD_SHARE = 0.4;

export function loadThreshold(cores: number): number {
  return LOAD_SHARE * cores;
}

interface Load {
  /** Логических ядер: порог — LOAD_SHARE × ядра. */
  readonly cores: number;
  readonly before: number;
  readonly after: number;
  readonly threshold: number;
  /** Сколько ждали, пока нагрузка опустится ниже порога. */
  readonly waitedMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface Idle {
  readonly idle: boolean;
  readonly load: number;
  readonly waitedMs: number;
}

/** Ждёт, пока нагрузка не выше порога, но не дольше timeoutMs; опрос — раз в pollMs. */
export async function waitForIdle(load: () => number, threshold: number, timeoutMs: number, clock: Clock, pollMs = 5000): Promise<Idle> {
  const started = clock.now();
  for (;;) {
    const current = load();
    const waitedMs = clock.now() - started;
    if (current <= threshold) return { idle: true, load: current, waitedMs };
    if (waitedMs >= timeoutMs) return { idle: false, load: current, waitedMs };
    await clock.sleep(pollMs);
  }
}

interface Speed {
  readonly silentPerCore: number;
  readonly statsPerCore: number;
}

export type Verdict = { readonly measured: true; readonly text: string } | { readonly measured: false; readonly text: string };

const rate = (value: number): string => Math.round(value).toLocaleString('ru-RU');

export function verdict(load: Load, speed: Speed | null, environment: string): Verdict {
  const waited = `ждал ${String(Math.round(load.waitedMs / 1000))} с`;
  const loads =
    `ядер ${String(load.cores)}, порог ${load.threshold.toFixed(2)} (${String(LOAD_SHARE)} × ядра), ` +
    `нагрузка ${load.before.toFixed(2)} до и ${Number.isNaN(load.after) ? '—' : load.after.toFixed(2)} после, ${waited}`;
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
