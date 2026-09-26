import { createHash } from 'node:crypto';
import type { GameConfig } from '../../src/core/model/config.ts';
import type { RoundEvent } from '../../src/core/model/events.ts';

// Фикстуры раундов: что ищем и в каком виде храним. Раунд — простые данные: сид, итог и события.

export interface RoundSummary {
  readonly payX100: number;
  readonly featured: boolean;
  readonly retriggers: number;
  readonly capped: boolean;
  /** Выигрышных шагов в основном спине. */
  readonly baseSteps: number;
  readonly maxClusterMult: number;
}

export function summarize(events: readonly RoundEvent[]): RoundSummary {
  let payX100 = 0;
  let featured = false;
  let retriggers = 0;
  let capped = false;
  let baseSteps = 0;
  let maxClusterMult = 0;
  for (const event of events) {
    if (event.t === 'fsStart') featured = true;
    else if (event.t === 'fsRetrigger') retriggers += 1;
    else if (event.t === 'cap') capped = true;
    else if (event.t === 'end') payX100 = event.payX100;
    else if (event.t === 'win') {
      if (!featured) baseSteps += 1;
      for (const cluster of event.clusters) maxClusterMult = Math.max(maxClusterMult, cluster.mult);
    }
  }
  return { payX100, featured, retriggers, capped, baseSteps, maxClusterMult };
}

export interface FixtureSpec {
  readonly name: string;
  readonly description: string;
  /** null — самый крупный на сидах отчёта, иначе первый сид по возрастанию, для которого условие выполнено. */
  readonly accepts: ((round: RoundSummary) => boolean) | null;
}

export const FIXTURES: readonly FixtureSpec[] = [
  { name: 'loss', description: 'Проигрыш: ни одного кластера, фичи нет.', accepts: (r) => r.payX100 === 0 && !r.featured },
  {
    name: 'small-win',
    description: 'Выигрыш не больше ставки, без фичи: строгий пресет его не празднует.',
    accepts: (r) => r.payX100 > 0 && r.payX100 <= 100 && !r.featured,
  },
  {
    name: 'base-win',
    description: 'Обычный выигрыш больше ставки: один шаг в основной игре, без фичи.',
    accepts: (r) => r.payX100 > 100 && r.baseSteps === 1 && !r.featured,
  },
  { name: 'cascade-3', description: 'Каскад в три шага и больше в основной игре, без фичи.', accepts: (r) => r.baseSteps >= 3 && !r.featured },
  { name: 'multiplier-8', description: 'Кластер с множителем ×8 и выше.', accepts: (r) => r.maxClusterMult >= 8 },
  { name: 'feature-start', description: 'Старт фичи без ретриггера и капа.', accepts: (r) => r.featured && r.retriggers === 0 && !r.capped },
  { name: 'retrigger', description: 'Фича с ретриггером.', accepts: (r) => r.retriggers >= 1 },
  { name: 'biggest', description: 'Самый крупный выигрыш на сидах отчёта [0, 10⁸), при равенстве — меньший сид.', accepts: null },
];

/** SHA-256 конфига: фикстура, записанная на другом конфиге, — устаревшая. */
export function configFingerprint(config: GameConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export interface Fixture {
  readonly name: string;
  readonly description: string;
  readonly seed: number;
  readonly config: 'DEFAULT_CONFIG';
  readonly configSha256: string;
  readonly payX100: number;
  readonly events: readonly RoundEvent[];
}

/** JSON с событием на строку: читается глазами и даёт короткий diff при пересборке. */
export function formatFixture(fixture: Fixture): string {
  const head = (['name', 'description', 'seed', 'config', 'configSha256', 'payX100'] as const).map(
    (key) => `  ${JSON.stringify(key)}: ${JSON.stringify(fixture[key])},`,
  );
  const events = fixture.events.map((event, index) => `    ${JSON.stringify(event)}${index < fixture.events.length - 1 ? ',' : ''}`);
  return ['{', ...head, '  "events": [', ...events, '  ]', '}', ''].join('\n');
}
