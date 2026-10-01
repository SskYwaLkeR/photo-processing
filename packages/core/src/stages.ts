import type { ImageStatus, Stage, TaskStatus } from '@prisma/client';

export const STAGES = ['CONVERT', 'COMPRESS', 'VARIANTS'] as const satisfies readonly Stage[];

export function nextStage(stage: Stage): Stage | null {
  return STAGES[STAGES.indexOf(stage) + 1] ?? null;
}

export function parseStage(value: string): Stage | null {
  const upper = value.toUpperCase();
  return (STAGES as readonly string[]).includes(upper) ? (upper as Stage) : null;
}

const RUNNING_STATE: Record<Stage, string> = { CONVERT: 'CONVERTING', COMPRESS: 'COMPRESSING', VARIANTS: 'GENERATING_VARIANTS' };
const QUEUED_STATE: Record<Stage, string> = {
  CONVERT: 'QUEUED_CONVERSION',
  COMPRESS: 'QUEUED_COMPRESSION',
  VARIANTS: 'QUEUED_VARIANTS',
};

/**
 * Fine-grained pipeline state for the API, derived from the image row and its single active task
 * (the DB guarantees there is at most one). Storing it separately would be a second source of truth.
 */
export function derivedState(status: ImageStatus, stage: Stage | null, activeTask: { status: TaskStatus } | null): string {
  if (status === 'COMPLETE') return 'COMPLETED';
  if (status !== 'PROCESSING' || !stage) return status;
  return activeTask?.status === 'RUNNING' ? RUNNING_STATE[stage] : QUEUED_STATE[stage];
}
