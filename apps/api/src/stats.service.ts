import { db } from '@pipeline/core/prisma';
import { STAGES } from '@pipeline/core/stages';
import { admissionStats } from './admission';

interface StageRow {
  stage: string;
  queued: number;
  retrying: number;
  running: number;
  oldest_ms: number | null;
}

/**
 * Operator view. Per stage: depth, age of the oldest due task (the autoscaling signal — age maps to a
 * latency SLO, depth alone doesn't), throughput, latency percentiles, the "DLQ" (FAILED tasks), and live
 * replicas from the worker registry. Every query hits a partial or composite index.
 */
export async function pipelineStats() {
  const prisma = db();
  const [active, done, failed, workers, images, inFlight] = await Promise.all([
    prisma.$queryRaw<StageRow[]>`
      SELECT stage::text AS stage,
             count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
             count(*) FILTER (WHERE status = 'QUEUED' AND attempts > 0)::int AS retrying,
             count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
             (EXTRACT(EPOCH FROM now() - min(available_at) FILTER (WHERE status = 'QUEUED' AND available_at <= now())) * 1000)::float8 AS oldest_ms
      FROM tasks WHERE status IN ('QUEUED', 'RUNNING') GROUP BY stage`,
    prisma.$queryRaw<{ stage: string; done_last_min: number; p50: number | null; p95: number | null; p99: number | null }[]>`
      SELECT stage::text AS stage,
             count(*) FILTER (WHERE finished_at > now() - interval '60 seconds')::int AS done_last_min,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p99
      FROM tasks WHERE status = 'DONE' AND finished_at > now() - interval '5 minutes' GROUP BY stage`,
    prisma.$queryRaw<{ stage: string; failed: number }[]>`
      SELECT stage::text AS stage, count(*)::int AS failed FROM tasks WHERE status = 'FAILED' GROUP BY stage`,
    prisma.$queryRaw<{ id: string; stage: string; pid: number; concurrency: number; in_flight: number; draining: boolean }[]>`
      SELECT id, stage::text AS stage, pid, concurrency, in_flight, draining
      FROM workers WHERE heartbeat_at > now() - interval '10 seconds' ORDER BY stage, started_at`,
    prisma.$queryRaw<{ status: string; count: number }[]>`SELECT status::text AS status, count(*)::int AS count FROM images GROUP BY status`,
    prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tasks WHERE status IN ('QUEUED', 'RUNNING')`,
  ]);

  const by = <T extends { stage: string }>(rows: T[]) => new Map(rows.map((r) => [r.stage, r]));
  const a = by(active);
  const d = by(done);
  const f = by(failed);

  return {
    at: new Date().toISOString(),
    stages: STAGES.map((stage) => {
      const replicas = workers.filter((w) => w.stage === stage);
      return {
        stage,
        queued: a.get(stage)?.queued ?? 0,
        retrying: a.get(stage)?.retrying ?? 0,
        running: a.get(stage)?.running ?? 0,
        oldestQueuedMs: Math.round(a.get(stage)?.oldest_ms ?? 0),
        doneLastMinute: d.get(stage)?.done_last_min ?? 0,
        p50Ms: Math.round(d.get(stage)?.p50 ?? 0),
        p95Ms: Math.round(d.get(stage)?.p95 ?? 0),
        p99Ms: Math.round(d.get(stage)?.p99 ?? 0),
        failed: f.get(stage)?.failed ?? 0,
        replicas: replicas.length,
        slots: replicas.reduce((n, w) => n + w.concurrency, 0),
        workers: replicas.map((w) => ({ id: w.id, pid: w.pid, inFlight: w.in_flight, concurrency: w.concurrency, draining: w.draining })),
      };
    }),
    images: Object.fromEntries(images.map((r) => [r.status, r.count])),
    admission: { inFlight: inFlight[0]?.n ?? 0, ...admissionStats() },
  };
}
