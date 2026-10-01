// Сессия на экране (§11, решение 6): чистый результат и время. Числа ставятся в DOM через ref — без рендеров React:
// время идёт раз в секунду, и бюджет «≤ 10 рендеров App за раунд» на него не тратится. React перерисовывает полосу
// только при смене языка.

import { useEffect, useRef } from 'react';
import type { ExternalSource } from './external.ts';
import { useLanguage } from './language-context.ts';
import type { MoneyFormat } from './money-format.ts';
import type { SessionView } from './session.ts';

/** Чистый результат со знаком: «+12,50», «−3,00» (минус U+2212), «0,00». */
export function signedMoney(money: MoneyFormat, minor: number): string {
  if (minor === 0) return money.format(0);
  return `${minor > 0 ? '+' : '−'}${money.format(Math.abs(minor))}`;
}

/** Время сессии: «05:32», с часа — «1:05:32». */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface SessionStripProps {
  readonly session: ExternalSource<SessionView>;
  readonly now: () => number;
  readonly className: string;
}

export function SessionStrip({ session, now, className }: SessionStripProps) {
  const { dict, money } = useLanguage();
  const netRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const paintNet = (): void => {
      if (netRef.current !== null) netRef.current.textContent = signedMoney(money, session.getSnapshot().netMinor);
    };
    const paintTime = (): void => {
      if (timeRef.current !== null) timeRef.current.textContent = elapsed(now() - session.getSnapshot().startedAt);
    };
    paintNet();
    paintTime();
    const unsubscribe = session.subscribe(paintNet);
    const timer = window.setInterval(paintTime, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [session, now, money]);
  return (
    <p className={className} data-testid="session">
      <span className="session-label">{dict.text.sessionNet}</span>
      <span className="session-value" data-testid="session-net" ref={netRef} />
      <span className="session-label">{dict.text.sessionTime}</span>
      <span className="session-value" data-testid="session-time" ref={timeRef} />
    </p>
  );
}
