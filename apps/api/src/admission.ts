import { config } from '@pipeline/core/config';
import { db } from '@pipeline/core/prisma';
import { HttpError } from './http';

/** 429s in the last minute, for the operator view. Per API instance (in memory) — fine for a gauge. */
const recent: { at: number; code: string }[] = [];

function record(code: string) {
  const now = Date.now();
  recent.push({ at: now, code });
  while (recent.length && recent[0]!.at < now - 60_000) recent.shift();
}

/**
 * Admission control: the edge of the backpressure chain. Every queue behind this point is bounded
 * because we stop accepting new work here:
 *  - global: active tasks across ALL stages ≥ watermark → 429 PIPELINE_BUSY. Counting every stage
 *    (not just CONVERT) means a slow downstream stage still sheds load at the API.
 *  - per user: UPLOADING + PROCESSING ≥ cap → 429, so one user can't fill the pipeline.
 * Both answer with Retry-After; the load test honours it.
 *
 * Soft limits, deliberately: count-then-insert can overshoot by the number of concurrent requests.
 * A hard cap needs a counter row with a conditional UPDATE, which is a hot row under load.
 */
export async function admit(userId: string): Promise<void> {
  const [row] = await db().$queryRaw<{ user: number; global: number }[]>`
    SELECT (SELECT count(*) FROM images WHERE user_id = ${userId}::uuid AND status IN ('UPLOADING', 'PROCESSING'))::int AS "user",
           (SELECT count(*) FROM tasks WHERE status IN ('QUEUED', 'RUNNING'))::int AS "global"`;
  if (!row) return;
  if (row.global >= config.admission.globalMaxInFlight) {
    record('PIPELINE_BUSY');
    throw new HttpError(429, 'PIPELINE_BUSY', 'The pipeline is at capacity. Retry shortly.', 5);
  }
  if (row.user >= config.admission.userMaxInFlight) {
    record('USER_IN_FLIGHT_LIMIT');
    throw new HttpError(429, 'USER_IN_FLIGHT_LIMIT', `You already have ${row.user} images in progress. Retry shortly.`, 3);
  }
}

export function admissionStats() {
  const cutoff = Date.now() - 60_000;
  const window = recent.filter((r) => r.at >= cutoff);
  return {
    globalMaxInFlight: config.admission.globalMaxInFlight,
    userMaxInFlight: config.admission.userMaxInFlight,
    rejectedLastMinute: window.length,
    rejectedByCode: window.reduce<Record<string, number>>((acc, r) => ((acc[r.code] = (acc[r.code] ?? 0) + 1), acc), {}),
  };
}
