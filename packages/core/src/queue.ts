import { Prisma, type PrismaClient, type Stage, type VariantName } from '@prisma/client';
import { config } from './config';
import { ERRORS, type ErrorCode } from './errors';
import { nextStage } from './stages';

/**
 * The tasks table is the queue: one row per (image, run, stage), status = job state, locked_at = lease.
 *
 * Why Postgres and not SQS: completing a stage and enqueuing the next one happen in ONE transaction,
 * so "stage done but next stage never enqueued" (the dual-write problem that needs an outbox with a
 * broker) cannot happen. Every function below is the swap seam if throughput ever outgrows it.
 *
 * Correctness rests on three mechanisms:
 *  - claim: FOR UPDATE SKIP LOCKED, so two replicas can never claim the same row.
 *  - fencing: every write is conditional on (status = RUNNING, locked_by = me) for the task and
 *    (run = task.run) for the image. A zombie worker whose lease expired writes nothing.
 *  - uniqueness: (image_id, run, stage) is unique and at most one task per image is active, so a
 *    duplicate enqueue is an ON CONFLICT no-op.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ClaimedTask {
  id: string;
  imageId: string;
  run: number;
  stage: Stage;
  attempts: number;
  userId: string;
  originalKey: string;
  originalBytes: number | null;
  normalizedKey: string | null;
  masterKey: string | null;
}

export interface VariantOutput {
  name: VariantName;
  key: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

export type StageResult =
  | {
      stage: 'CONVERT';
      originalFormat: string;
      originalBytes: number;
      width: number;
      height: number;
      normalizedKey: string;
      normalizedBytes: number;
    }
  | { stage: 'COMPRESS'; masterKey: string; compressedBytes: number; compressionRatio: number; quality: number }
  | { stage: 'VARIANTS'; variants: VariantOutput[] };

export type Outcome = 'DONE' | 'FENCED';

const leaseInterval = () => Prisma.sql`(${config.worker.leaseMs}::int * interval '1 millisecond')`;

/** Insert the task for `stage`. A duplicate (redelivery, double reprocess) is silently ignored. */
export async function enqueue(tx: Db, imageId: string, run: number, stage: Stage, detail?: string): Promise<boolean> {
  const inserted = await tx.$executeRaw`
    INSERT INTO tasks (id, image_id, run, stage)
    VALUES (gen_random_uuid(), ${imageId}::uuid, ${run}::int, ${stage}::"Stage")
    ON CONFLICT DO NOTHING`;
  if (inserted === 1) await event(tx, imageId, run, stage, 'QUEUED', detail);
  return inserted === 1;
}

export async function event(tx: Db, imageId: string, run: number, stage: Stage | null, type: string, detail?: string) {
  await tx.$executeRaw`
    INSERT INTO image_events (image_id, run, stage, type, detail)
    VALUES (${imageId}::uuid, ${run}::int, ${stage}::"Stage", ${type}, ${detail ?? null})`;
}

/**
 * Claim up to `limit` tasks for one stage: due QUEUED tasks, or RUNNING ones whose lease expired
 * (the worker crashed) and still have attempts left. One statement: pick, lease, log, return.
 */
export async function claim(db: PrismaClient, stage: Stage, limit: number, workerId: string): Promise<ClaimedTask[]> {
  const rows = await db.$queryRaw<(Omit<ClaimedTask, 'stage'> & { stage: string })[]>`
    WITH picked AS (
      SELECT id FROM tasks
      WHERE stage = ${stage}::"Stage"
        AND attempts < ${config.worker.maxAttempts}::int
        AND ((status = 'QUEUED' AND available_at <= now())
          OR (status = 'RUNNING' AND locked_at < now() - ${leaseInterval()}))
      ORDER BY available_at
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE tasks t
      SET status = 'RUNNING', locked_at = now(), locked_by = ${workerId},
          attempts = t.attempts + 1, started_at = COALESCE(t.started_at, now())
      FROM picked WHERE t.id = picked.id
      RETURNING t.id, t.image_id, t.run, t.stage, t.attempts
    ), logged AS (
      INSERT INTO image_events (image_id, run, stage, type, detail)
      SELECT image_id, run, stage, 'STARTED', 'attempt ' || attempts || ' on ' || ${workerId} FROM claimed
    )
    SELECT c.id::text AS id, c.image_id::text AS "imageId", c.run, c.stage::text AS stage, c.attempts,
           i.user_id::text AS "userId", i.original_key AS "originalKey", i.original_bytes AS "originalBytes",
           i.normalized_key AS "normalizedKey", i.master_key AS "masterKey"
    FROM claimed c JOIN images i ON i.id = c.image_id`;
  return rows.map((r) => ({ ...r, stage: r.stage as Stage }));
}

/** Renew leases. Returns the ids this worker still owns; anything missing was reclaimed elsewhere. */
export async function heartbeat(db: PrismaClient, workerId: string, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE tasks SET locked_at = now()
    WHERE id = ANY(${taskIds}::uuid[]) AND locked_by = ${workerId} AND status = 'RUNNING'
    RETURNING id::text AS id`;
  return new Set(rows.map((r) => r.id));
}

class Fenced extends Error {}

/** Fenced task transition: only the current lease holder can move its task out of RUNNING. */
async function finishTask(tx: Db, task: ClaimedTask, workerId: string, status: 'DONE' | 'FAILED', lastError: string | null, durationMs: number) {
  const owned = await tx.$executeRaw`
    UPDATE tasks
    SET status = ${status}::"TaskStatus", finished_at = now(), duration_ms = ${durationMs}::int,
        locked_at = NULL, last_error = ${lastError}
    WHERE id = ${task.id}::uuid AND status = 'RUNNING' AND locked_by = ${workerId}`;
  if (owned !== 1) throw new Fenced();
}

/**
 * Stage succeeded: record outputs, mark the task DONE and enqueue the next stage, atomically.
 * For VARIANTS, the image only becomes COMPLETE after all three variant rows are upserted and counted.
 */
export async function complete(db: PrismaClient, task: ClaimedTask, workerId: string, result: StageResult, durationMs: number): Promise<Outcome> {
  try {
    await db.$transaction(async (tx) => {
      await finishTask(tx, task, workerId, 'DONE', null, durationMs);
      const next = nextStage(task.stage);
      const current = { id: task.imageId, run: task.run, status: 'PROCESSING' as const };

      let data: Prisma.ImageUpdateManyMutationInput;
      if (result.stage === 'CONVERT') {
        const { stage: _, ...outputs } = result;
        data = { ...outputs, stage: next };
      } else if (result.stage === 'COMPRESS') {
        data = {
          masterKey: result.masterKey,
          compressedBytes: result.compressedBytes,
          compressionRatio: result.compressionRatio,
          compressionQuality: result.quality,
          stage: next,
        };
      } else {
        for (const v of result.variants) {
          await tx.variant.upsert({
            where: { imageId_name: { imageId: task.imageId, name: v.name } },
            create: { imageId: task.imageId, run: task.run, ...v },
            update: { run: task.run, ...v },
          });
        }
        const count = await tx.variant.count({ where: { imageId: task.imageId, run: task.run } });
        if (count !== 3) throw new Error(`Expected 3 variants for run ${task.run}, found ${count}`);
        data = { status: 'COMPLETE', completedAt: new Date(), pipelineVersion: config.pipelineVersion };
      }

      const { count } = await tx.image.updateMany({ where: current, data });
      if (count !== 1) throw new Fenced(); // run was bumped or image left PROCESSING: discard everything

      await event(tx, task.imageId, task.run, task.stage, 'DONE', `${durationMs} ms`);
      if (next) await enqueue(tx, task.imageId, task.run, next);
      else await event(tx, task.imageId, task.run, null, 'COMPLETED');
    });
    return 'DONE';
  } catch (err) {
    if (err instanceof Fenced) return 'FENCED';
    throw err;
  }
}

/** Stop the pipeline for this image with a user-facing reason. No retries. */
export async function failPermanent(db: PrismaClient, task: ClaimedTask, workerId: string, code: ErrorCode, rawError: string, durationMs: number): Promise<Outcome> {
  try {
    await db.$transaction(async (tx) => {
      await finishTask(tx, task, workerId, 'FAILED', rawError, durationMs);
      await tx.image.updateMany({
        where: { id: task.imageId, run: task.run, status: 'PROCESSING' },
        data: { status: 'FAILED', errorStage: task.stage, errorCode: code, errorMessage: ERRORS[code].message, retryable: ERRORS[code].retryable },
      });
      await event(tx, task.imageId, task.run, task.stage, 'FAILED', code);
    });
    return 'DONE';
  } catch (err) {
    if (err instanceof Fenced) return 'FENCED';
    throw err;
  }
}

/** Exponential backoff with jitter: ~1s, ~2s, ~4s … capped at 30s. Jitter spreads retry storms. */
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/** Transient failure: requeue with backoff while attempts remain, then fail with a retryable code. */
export async function failTransient(
  db: PrismaClient,
  task: ClaimedTask,
  workerId: string,
  exhaustedCode: ErrorCode,
  rawError: string,
  durationMs: number,
): Promise<Outcome> {
  if (task.attempts >= config.worker.maxAttempts) return failPermanent(db, task, workerId, exhaustedCode, rawError, durationMs);
  const delay = backoffMs(task.attempts);
  try {
    await db.$transaction(async (tx) => {
      const owned = await tx.$executeRaw`
        UPDATE tasks
        SET status = 'QUEUED', locked_at = NULL, locked_by = NULL, last_error = ${rawError},
            available_at = now() + (${delay}::int * interval '1 millisecond')
        WHERE id = ${task.id}::uuid AND status = 'RUNNING' AND locked_by = ${workerId}`;
      if (owned !== 1) throw new Fenced();
      // Timeline is user-visible: say what happens next, not the raw error.
      await event(tx, task.imageId, task.run, task.stage, 'RETRY_SCHEDULED', `attempt ${task.attempts} failed, retrying in ${Math.round(delay / 100) / 10}s`);
    });
    return 'DONE';
  } catch (err) {
    if (err instanceof Fenced) return 'FENCED';
    throw err;
  }
}

/** Graceful shutdown: hand unfinished tasks back immediately instead of waiting for lease expiry. */
export async function release(db: PrismaClient, workerId: string, taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  return db.$executeRaw`
    UPDATE tasks
    SET status = 'QUEUED', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0), available_at = now()
    WHERE id = ANY(${taskIds}::uuid[]) AND locked_by = ${workerId} AND status = 'RUNNING'`;
}

/**
 * Housekeeping, safe to run from every replica concurrently (each statement is idempotent):
 * a RUNNING task whose lease expired on its final attempt can't be reclaimed, so it fails the image
 * with TIMED_OUT here. That is what guarantees no image stays PROCESSING forever.
 */
export async function sweep(db: PrismaClient, stage: Stage): Promise<number> {
  return db.$executeRaw`
    WITH dead AS (
      UPDATE tasks
      SET status = 'FAILED', locked_at = NULL, finished_at = now(),
          last_error = left(COALESCE(last_error || ' | ', '') || 'lease expired on final attempt', 1000)
      WHERE stage = ${stage}::"Stage" AND status = 'RUNNING'
        AND attempts >= ${config.worker.maxAttempts}::int
        AND locked_at < now() - ${leaseInterval()}
      RETURNING image_id, run, stage
    ), failed AS (
      UPDATE images i
      SET status = 'FAILED', error_stage = d.stage, error_code = 'TIMED_OUT',
          error_message = ${ERRORS.TIMED_OUT.message}, retryable = true, updated_at = now()
      FROM dead d
      WHERE i.id = d.image_id AND i.run = d.run AND i.status = 'PROCESSING'
    )
    INSERT INTO image_events (image_id, run, stage, type, detail)
    SELECT image_id, run, stage, 'FAILED', 'TIMED_OUT' FROM dead`;
}
