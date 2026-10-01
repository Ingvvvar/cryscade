// Счётчик WebAudio для e2e и замера утечек (§12): init script страницы оборачивает конструктор AudioContext, фабрики
// узлов BaseAudioContext.prototype.create* и start источников — и AudioScheduledSourceNode, и AudioBufferSourceNode:
// у последнего свой start (проба фазы 8). Завершённые — по событию ended.

export interface AudioCounts {
  readonly contexts: number;
  readonly created: Readonly<Record<string, number>>;
  readonly started: number;
  readonly ended: number;
  readonly states: readonly string[];
}

export type AudioWindow = Window & { __audioCounts?: AudioCounts & { contexts: number; started: number; ended: number; created: Record<string, number> }; __audioContexts?: AudioContext[] };

/** Init script: функция без замыканий — Playwright передаёт её текстом. */
export function installAudioCounter(): void {
  const scope = window as AudioWindow;
  const counts = { contexts: 0, created: {} as Record<string, number>, started: 0, ended: 0, states: [] as string[] };
  scope.__audioCounts = counts;
  scope.__audioContexts = [];
  const Original = window.AudioContext;
  if (typeof Original !== 'function') return;
  window.AudioContext = class extends Original {
    constructor(options?: AudioContextOptions) {
      super(options);
      counts.contexts += 1;
      scope.__audioContexts?.push(this);
    }
  };
  const prototype = BaseAudioContext.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(BaseAudioContext.prototype)) {
    if (!name.startsWith('create')) continue;
    const original = prototype[name];
    if (typeof original !== 'function') continue;
    prototype[name] = function (this: BaseAudioContext, ...args: unknown[]): unknown {
      const type = name.slice(6);
      counts.created[type] = (counts.created[type] ?? 0) + 1;
      return (original as (...rest: unknown[]) => unknown).apply(this, args);
    };
  }
  for (const Source of [AudioScheduledSourceNode, AudioBufferSourceNode]) {
    const start = Reflect.get(Source.prototype, 'start') as (this: AudioScheduledSourceNode, ...args: unknown[]) => void;
    Source.prototype.start = function (this: AudioScheduledSourceNode, ...args: unknown[]): void {
      counts.started += 1;
      this.addEventListener('ended', () => {
        counts.ended += 1;
      });
      start.apply(this, args);
    };
  }
}
