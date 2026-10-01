// Директор звука (§12, решения 2, 3 и 5 фазы 8): ход часов показа → сигналы таблицы раунда → голос. Тикер — сигналы
// звучат по одному в своё время; пропуск — сигналы между молчат, после — один итоговый, старший из пропущенных.
// Фон приседает только под выигрыш, фичу и большой выигрыш; во фриспинах — теплее. В кадре — только курсор и числа.

import type { Schedule } from '../core/presentation/index.ts';
import { buildCues, ducks, type CueKind, type CueTable } from './cues.ts';

/** Голос (Strategy): WebAudio в браузере, журнал в тестах. */
export interface Voice {
  play(kind: CueKind, value: number): void;
  /** Фон приседает на holdMs. */
  duck(holdMs: number): void;
  setWarm(on: boolean): void;
  setMuted(on: boolean): void;
  /** Скрытая вкладка — контекст на паузе. */
  setHidden(on: boolean): void;
}

export class SoundDirector {
  readonly #voice: Voice;
  #table: CueTable | null = null;
  #cursor = 0;
  #warm = false;

  constructor(voice: Voice) {
    this.#voice = voice;
  }

  /** Показ раунда начался с fromMs: сигналы раньше него не звучат. */
  started(schedule: Schedule, fromMs: number): void {
    const table = buildCues(schedule);
    this.#table = table;
    let cursor = 0;
    while (cursor < table.length && (table.times[cursor] ?? 0) < fromMs) cursor += 1;
    this.#cursor = cursor;
    this.#setWarm(fromMs >= table.warmFrom && fromMs < table.durationMs);
  }

  /** Откуда шли часы, директору не нужно: курсор помнит, докуда таблица прозвучала. */
  advanced(_fromMs: number, toMs: number, jumped: boolean): void {
    const table = this.#table;
    if (table === null) return;
    let top = -1;
    while (this.#cursor < table.length && (table.times[this.#cursor] ?? 0) <= toMs) {
      if (!jumped) this.#emit(table, this.#cursor);
      else if (top < 0 || (table.kinds[this.#cursor] ?? 0) > (table.kinds[top] ?? 0)) top = this.#cursor;
      this.#cursor += 1;
    }
    if (top >= 0) this.#emit(table, top);
    this.#setWarm(toMs >= table.warmFrom && toMs < table.durationMs);
  }

  setMuted(on: boolean): void {
    this.#voice.setMuted(on);
  }

  setHidden(on: boolean): void {
    this.#voice.setHidden(on);
  }

  #emit(table: CueTable, index: number): void {
    const kind = (table.kinds[index] ?? 0) as CueKind;
    this.#voice.play(kind, table.values[index] ?? 0);
    if (ducks(kind)) this.#voice.duck(table.holds[index] ?? 0);
  }

  #setWarm(on: boolean): void {
    if (on === this.#warm) return;
    this.#warm = on;
    this.#voice.setWarm(on);
  }
}
