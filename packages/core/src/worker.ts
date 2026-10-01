import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Stage } from '@prisma/client';
import { config } from './config';
import { classify, errorText, LeaseLostError, TaskTimeoutError } from './errors';
import { log } from './log';
import { db } from './prisma';
import { claim, complete, failPermanent, failTransient, heartbeat, release, sweep, type ClaimedTask, type StageResult } from './queue';

/** A stage implementation: pure input → output on S3. It never touches the queue or the DB. */
export type Handler = (task: ClaimedTask, signal: AbortSignal) => Promise<StageResult>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects as soon as the signal aborts (lease lost / timeout), without waiting for the handler. */
function guard<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The generic stateless worker loop shared by all three services. Nothing durable lives in this
 * process: the lease in Postgres is the only record that a task is being worked on, so killing the
 * process at any point loses nothing (the lease expires and another replica reclaims the task).
 *
 * Backpressure: the loop only claims as many tasks as it has free slots (pull, no prefetch), so a
 * slow stage builds a queue in Postgres instead of piling work into memory.
 */
export async function runWorker(stage: Stage, handler: Handler): Promise<void> {
  const prisma = db();
  const concurrency = config.worker.concurrency(stage);
  const workerId = `${stage.toLowerCase()}-${hostname().split('.')[0]}-${process.pid}-${randomBytes(2).toString('hex')}`;
  const chaos = config.chaos.stage === stage;

  /** Tasks whose lease we hold and renew. */
  const leases = new Map<string, AbortController>();
  /** Slots stay busy until the handler's work actually settles, even after a timeout: libvips
   *  can't be cancelled, so freeing the slot early would oversubscribe CPU and memory. */
  let busy = 0;
  let wake: () => void = () => {};
  let stopping = false;

  const register = (draining = false) =>
    prisma.$executeRaw`
      INSERT INTO workers (id, stage, pid, concurrency, in_flight, draining, started_at, heartbeat_at)
      VALUES (${workerId}, ${stage}::"Stage", ${process.pid}::int, ${concurrency}::int, ${busy}::int, ${draining}, now(), now())
      ON CONFLICT (id) DO UPDATE SET in_flight = EXCLUDED.in_flight, draining = EXCLUDED.draining, heartbeat_at = now()`;

  async function execute(task: ClaimedTask): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    leases.set(task.id, controller);
    const timer = setTimeout(
      () => controller.abort(new TaskTimeoutError(`Task exceeded ${config.worker.taskTimeoutMs} ms`)),
      config.worker.taskTimeoutMs,
    );
    const ctx = { taskId: task.id, imageId: task.imageId, run: task.run, stage, attempt: task.attempts, workerId };
    log('task.started', ctx);

    const work = chaos && Math.random() < config.chaos.rate
      ? Promise.reject(new Error('Injected failure (CHAOS_FAIL_STAGE)'))
      : handler(task, controller.signal);

    try {
      const result = await guard(work, controller.signal);
      const outcome = await complete(prisma, task, workerId, result, Date.now() - started);
      log('task.done', { ...ctx, outcome, durationMs: Date.now() - started, ...summary(result) });
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof LeaseLostError) {
        // Another replica owns the task now. Writing anything would be a zombie write, so don't.
        log('task.lease_lost', { ...ctx, durationMs });
      } else {
        const c = classify(err);
        const raw = errorText(err);
        const outcome =
          c.kind === 'permanent'
            ? await failPermanent(prisma, task, workerId, c.code, raw, durationMs)
            : await failTransient(prisma, task, workerId, err instanceof TaskTimeoutError ? 'TIMED_OUT' : 'PROCESSING_FAILED', raw, durationMs);
        log('task.failed', { ...ctx, kind: c.kind, errorCode: c.kind === 'permanent' ? c.code : undefined, error: raw, outcome, durationMs });
      }
    } finally {
      clearTimeout(timer);
      leases.delete(task.id);
      await work.catch(() => {}); // hold the slot until the CPU work is really over
      busy -= 1;
      wake();
    }
  }

  const beat = setInterval(async () => {
    const ids = [...leases.keys()];
    try {
      const owned = await heartbeat(prisma, workerId, ids);
      for (const id of ids) if (!owned.has(id)) leases.get(id)?.abort(new LeaseLostError(`Lease lost for ${id}`));
    } catch (err) {
      log('heartbeat.failed', { workerId, error: errorText(err) });
    }
  }, Math.floor(config.worker.leaseMs / 3));

  const registry = setInterval(() => register(stopping).catch(() => {}), config.worker.registryIntervalMs);
  const sweeper = setInterval(() => {
    sweep(prisma, stage)
      .then((n) => n > 0 && log('sweep.timed_out', { stage, count: n }))
      .catch((err) => log('sweep.failed', { stage, error: errorText(err) }));
  }, config.worker.sweepIntervalMs);

  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    wake();
    log('worker.draining', { workerId, stage, signal, inFlight: busy });
    await register(true).catch(() => {});
    const deadline = Date.now() + config.worker.drainMs;
    while (busy > 0 && Date.now() < deadline) await sleep(100);
    const released = await release(prisma, workerId, [...leases.keys()]).catch(() => 0);
    clearInterval(beat);
    clearInterval(registry);
    clearInterval(sweeper);
    await prisma.$executeRaw`DELETE FROM workers WHERE id = ${workerId}`.catch(() => {});
    await prisma.$disconnect();
    log('worker.stopped', { workerId, stage, released });
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await register();
  log('worker.started', { workerId, stage, concurrency, chaos: chaos ? config.chaos.rate : undefined });

  let pollMs = config.worker.pollMinMs;
  while (!stopping) {
    const free = concurrency - busy;
    let claimed = 0;
    if (free > 0) {
      try {
        const tasks = await claim(prisma, stage, free, workerId);
        claimed = tasks.length;
        busy += claimed;
        for (const task of tasks) void execute(task);
      } catch (err) {
        log('claim.failed', { workerId, error: errorText(err) });
      }
    }
    // Idle backoff: an empty queue costs one cheap indexed query every ≤2 s per replica.
    pollMs = claimed > 0 ? config.worker.pollMinMs : Math.min(config.worker.pollMaxMs, pollMs * 2);
    if (free > 0 && claimed === free) continue; // probably more waiting: claim again right away
    await Promise.race([sleep(pollMs), new Promise<void>((resolve) => (wake = resolve))]);
  }
}

function summary(result: StageResult): Record<string, unknown> {
  if (result.stage === 'CONVERT') return { inBytes: result.originalBytes, outBytes: result.normalizedBytes, format: result.originalFormat };
  if (result.stage === 'COMPRESS') return { outBytes: result.compressedBytes, ratio: result.compressionRatio };
  return { variants: result.variants.map((v) => `${v.name}:${v.width}x${v.height}:${v.bytes}`) };
}
