// Звук (§12) — ленивый модуль: корень композиции грузит его динамическим импортом по первому жесту игрока и отдаёт
// AudioContext, созданный в том же жесте (LAZY_MODULES гейта сборки).

import { SoundDirector } from './director.ts';
import { WebAudioVoice, type VoiceOptions } from './synth.ts';

export { SoundDirector, type Voice } from './director.ts';
export { CUE, buildCues, ducks, type CueKind, type CueTable } from './cues.ts';

/** Звук игры на контексте из жеста: голос WebAudio и директор над ним. */
export function createSound(context: AudioContext, options: VoiceOptions): SoundDirector {
  return new SoundDirector(new WebAudioVoice(context, options));
}
