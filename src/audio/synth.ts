// Голос WebAudio (§12): синтез без файлов. Две шины — эффекты и фон — под общим мьютом. Фон грота — шум одного
// разделяемого буфера через фильтр с медленной модуляцией, во фриспинах теплее; приседает под выигрыш, фичу и большой
// выигрыш. Эффекты — осцилляторы с огибающими; каждый источник останавливается в конце своей огибающей и по ended
// отключается от графа — замер утечек (npm run sound:leaks) считает запущенные против завершённых.

import { CUE, type CueKind } from './cues.ts';
import type { Voice } from './director.ts';

/** Пентатоника от ля малой октавы: ступень step — полутона 0, 2, 4, 7, 9 в каждой октаве. */
const BASE_HZ = 220;
const PENTATONIC = [0, 2, 4, 7, 9] as const;

function pentatonic(step: number): number {
  const octave = Math.floor(step / PENTATONIC.length);
  const degree = PENTATONIC[((step % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length] ?? 0;
  return BASE_HZ * 2 ** ((12 * octave + degree) / 12);
}

/** Фон: прохладный и тёплый срез фильтра, уровень и приседание. */
const AMBIENCE = { cool: 420, warm: 900, level: 0.12, duck: 0.35 } as const;

export interface VoiceOptions {
  /**
   * Положительный контроль замера утечек (dev и e2e, ?soundleak=1): на каждый сигнал — источник, который не
   * останавливают. В проде флаг не ставится.
   */
  readonly leak: boolean;
}

export class WebAudioVoice implements Voice {
  readonly #context: AudioContext;
  readonly #options: VoiceOptions;
  readonly #master: GainNode;
  readonly #effects: GainNode;
  readonly #duck: GainNode;
  readonly #filter: BiquadFilterNode;
  #muted = false;

  constructor(context: AudioContext, options: VoiceOptions) {
    this.#context = context;
    this.#options = options;
    this.#master = context.createGain();
    this.#master.connect(context.destination);
    this.#effects = context.createGain();
    this.#effects.gain.value = 0.5;
    this.#effects.connect(this.#master);
    this.#duck = context.createGain();
    this.#duck.connect(this.#master);
    const ambience = context.createGain();
    ambience.gain.value = AMBIENCE.level;
    ambience.connect(this.#duck);
    this.#filter = context.createBiquadFilter();
    this.#filter.type = 'lowpass';
    this.#filter.frequency.value = AMBIENCE.cool;
    this.#filter.Q.value = 0.7;
    this.#filter.connect(ambience);
    // Один буфер шума на всю игру: 2 с, по кругу.
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2545f491;
    for (let index = 0; index < data.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[index] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    noise.connect(this.#filter);
    noise.start();
    // Медленная модуляция среза: дыхание грота.
    const lfo = context.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = context.createGain();
    depth.gain.value = 160;
    lfo.connect(depth);
    depth.connect(this.#filter.frequency);
    lfo.start();
  }

  /** Мьют — и без новых источников: эффекты не создаются вовсе. */
  play(kind: CueKind, value: number): void {
    if (this.#muted) return;
    const now = this.#context.currentTime;
    switch (kind) {
      case CUE.land:
        this.#thump(now, 95 * (1 + 0.07 * value));
        break;
      case CUE.cluster:
        this.#tone('triangle', pentatonic(5 + value), now, 0.35, 0.22);
        this.#tone('sine', pentatonic(8 + value), now + 0.03, 0.3, 0.08);
        break;
      case CUE.spot:
        this.#tone('sine', pentatonic(9 + value), now, 0.18, 0.16);
        this.#tone('sine', pentatonic(11 + value), now + 0.06, 0.16, 0.1);
        break;
      case CUE.core:
        this.#tone('sine', 660, now, 0.9, 0.18);
        this.#tone('sine', 660 * 2.76, now, 0.5, 0.05);
        break;
      case CUE.featureStart:
        this.#arpeggio(now, 10, 4, 0.09, 0.5);
        break;
      case CUE.retrigger:
        this.#arpeggio(now, 12, 3, 0.07, 0.35);
        break;
      case CUE.cap:
        for (const step of [10, 12, 14]) this.#tone('triangle', pentatonic(step), now, 1.4, 0.12);
        break;
      case CUE.win:
        this.#tone('sine', pentatonic(10), now, 0.6, 0.16);
        this.#tone('sine', pentatonic(12), now + 0.05, 0.6, 0.12);
        break;
      case CUE.bigWin:
        this.#arpeggio(now, 10, 3 + value, 0.11, 0.8);
        this.#tone('sine', pentatonic(20 + value), now + 0.2, 1.6, 0.05);
        break;
    }
    if (this.#options.leak) this.#context.createOscillator().start(now);
  }

  duck(holdMs: number): void {
    const gain = this.#duck.gain;
    const now = this.#context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(AMBIENCE.duck, now, 0.05);
    gain.setTargetAtTime(1, now + Math.max(0.2, holdMs / 1000), 0.4);
  }

  setWarm(on: boolean): void {
    this.#filter.frequency.setTargetAtTime(on ? AMBIENCE.warm : AMBIENCE.cool, this.#context.currentTime, 0.8);
  }

  setMuted(on: boolean): void {
    this.#muted = on;
    this.#master.gain.setTargetAtTime(on ? 0 : 1, this.#context.currentTime, 0.02);
  }

  setHidden(on: boolean): void {
    void (on ? this.#context.suspend() : this.#context.resume());
  }

  /** Тон с огибающей: атака 8 мс, экспоненциальный спад; источник — стоп в конце, отключение по ended. */
  #tone(type: OscillatorType, hz: number, at: number, seconds: number, peak: number): void {
    const context = this.#context;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = hz;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    oscillator.connect(envelope);
    envelope.connect(this.#effects);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      envelope.disconnect();
    });
    oscillator.start(at);
    oscillator.stop(at + seconds + 0.02);
  }

  /** Приземление колонки: синус, падающий по высоте, — глухой удар. */
  #thump(at: number, hz: number): void {
    const context = this.#context;
    const oscillator = context.createOscillator();
    oscillator.frequency.setValueAtTime(hz, at);
    oscillator.frequency.exponentialRampToValueAtTime(hz * 0.6, at + 0.12);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.18, at + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
    oscillator.connect(envelope);
    envelope.connect(this.#effects);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      envelope.disconnect();
    });
    oscillator.start(at);
    oscillator.stop(at + 0.16);
  }

  #arpeggio(at: number, from: number, notes: number, gap: number, seconds: number): void {
    for (let note = 0; note < notes; note++) this.#tone('triangle', pentatonic(from + note), at + note * gap, seconds, 0.16);
  }
}
