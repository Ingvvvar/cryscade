// Презентация раунда (§8): расписание по событиям, кадр как функция времени, контуры, тайминги, падение.
export { clusterContour, contourContains, SUBDIVISION, type ContourRing } from './contour.ts';
export { FALL, bounceCeiling, columnStartMs, fallHeight, fillColumnHeights, gridSettleMs, settleMs, type FallProfile } from './fall.ts';
export { finalGrid } from './final-grid.ts';
export { groupAt, sampleScene } from './sample-scene.ts';
export { EMPTY_CELL, PLAQUE, SceneState, type PlaqueKind } from './scene-state.ts';
export {
  CLEAR_DROP,
  buildSchedule,
  type CascadeStep,
  type Group,
  type GroupKind,
  type GroupStart,
  type Plaque,
  type Schedule,
  type ScheduleOptions,
  type ScheduleRound,
  type Segment,
  type SegmentKind,
  type StepCluster,
  type Tally,
} from './schedule.ts';
export {
  BIG_WIN,
  COUNTER_MAX_MS,
  COUNTER_MIN_MS,
  FLASHES_PER_SECOND,
  MAX_WIN_CELEBRATE_MS,
  MAX_WIN_LEVEL,
  TIMINGS,
  bigWinLevel,
  celebrateMs,
  counterMs,
  type SegmentTimings,
  type Speed,
} from './timings.ts';
