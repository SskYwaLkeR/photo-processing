# Architecture: Media Processing Pipeline

> After an image passes validation it moves through **convert → compress → variants**. Each stage is a
> separate, stateless service that can be scaled independently. Users can watch the state change, retrieve
> three variants with their metadata, or see a structured failure reason. The design goal is that at-least-once
> processing plus idempotent writes gives an **effectively-once outcome**, and that this is *proven*
> afterwards (`pnpm check`), not just asserted.

## 1. Shape

```
                       ┌──────────────── Postgres (state + queue) ────────────────┐
                       │ images · tasks (row = job) · variants · image_events     │
                       │ workers (liveness registry)                              │
                       └──▲───────────────▲───────────────▲───────────────▲───────┘
   browser / load test    │ claim         │ claim         │ claim         │ read
        │                 │ CONVERT       │ COMPRESS      │ VARIANTS      │
        ▼                 │               │               │               │
   ┌──────────┐ enqueue   │        ┌──────┴─────┐  ┌──────┴─────┐  ┌──────┴─────┐
   │ API (×N) │───────────┘        │ convert ×a │─▶│ compress ×b│─▶│ variants ×c│
   └────┬─────┘  429 + Retry-After └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
        │ presign                         ▼               ▼               ▼
        ▼          ┌──────────────────────────── S3 (bytes only) ─────────────────────┐
   presigned POST ▶│ originals/{u}/{id}            never served                       │
                   │ work/{u}/{id}/normalized.jpg  lifecycle: expire 7d               │
                   │ work/{u}/{id}/master.jpg                                         │
                   │ variants/{u}/{id}/{thumb,web,full}.jpg   only prefix ever served │
                   └──────────────────────────────────────────────────────────────────┘
```

Responsibilities, strictly separated:
- **S3 holds bytes.** It is never consulted for workflow state.
- **Postgres holds state and pending work.**
- **Workers hold nothing.** No local files, no in-memory job tracking, no process-local locks. You can kill a
  worker at any instant and nothing is lost: its lease expires and another replica reclaims the task.

## 2. Why the queue is Postgres (a deliberate deviation)

The usual advice is "don't use the database as your queue". Here there's a concrete reason to do it anyway:

| | Postgres `tasks` table (chosen) | SQS per stage + DLQ |
|---|---|---|
| Stage handoff | Mark the task DONE, write outputs, insert the next task: **one transaction** | DB commit, *then* publish. If the publish fails, the image is stuck "converted" forever. Needs a **transactional outbox** and a relay to be correct |
| User-visible state vs real work | Always the same rows, so they can't disagree | Two systems, so they can drift; needs reconciliation |
| Duplicate delivery | Unique `(image_id, run, stage)` plus `ON CONFLICT DO NOTHING` | Must dedupe in the consumer anyway |
| Infra | None extra | SQS ×3 + DLQ ×3, an outbox table, a relay process |
| Ceiling | Claim polling load on the OLTP DB, and connection count (replicas × pool) | Effectively unlimited |

So the dual-write problem (scenario S5 below) **cannot happen** by construction. The swap seam is the six
functions in `packages/core/src/queue.ts` (`enqueue`, `claim`, `heartbeat`, `complete`, `fail*`, `release`).
Moving to SQS means one queue per stage, a DLQ for each, and an outbox for the handoff. The trigger is sustained
thousands of jobs per minute, or claim queries showing up in DB load. See [ROADMAP](ROADMAP.md).

## 3. State machine

`images.status` is the coarse lifecycle. The fine-grained state the API returns is **derived** from
`images.stage` plus the image's single active task. Storing it separately would create a second source of truth.

```
UPLOADING ──/complete──▶ PROCESSING ────────────────────────────────────────────▶ COMPLETE
   │      (validation ok)   stage=CONVERT  QUEUED_CONVERSION → CONVERTING
   │                        stage=COMPRESS QUEUED_COMPRESSION → COMPRESSING
   │                        stage=VARIANTS QUEUED_VARIANTS → GENERATING_VARIANTS
   │                                 │
   ▼ (bad size/bytes)                ▼ permanent error, or retries exhausted, or final lease expired
REJECTED (422, no stage)         FAILED (error_stage, error_code, message, retryable)
                                     │
                                     └──/reprocess──▶ PROCESSING (run+1, resumes at error_stage)
```

| Rule | Enforced by |
|---|---|
| At most one QUEUED/RUNNING task per image | partial unique index `tasks_one_active_per_image` |
| One task per (image, run, stage) | unique index, `ON CONFLICT DO NOTHING` on enqueue |
| Only the lease holder can move a task out of RUNNING | `WHERE status='RUNNING' AND locked_by=$me` on every transition |
| A task from an old run can't touch the image | image writes are `WHERE run = task.run AND status='PROCESSING'` |
| COMPLETE ⇒ 3 variants of the current run | upsert 3 rows, `count = 3` check, then COMPLETE, all in one transaction. `pnpm check` verifies it afterwards |
| FAILED ⇒ stage + code + message | CHECK constraints `images_failure_has_reason`, `images_failed_has_stage` |
| No image PROCESSING forever | leases plus the sweeper (final-attempt expiry ⇒ `TIMED_OUT`) |
| Transitions are append-logged | `image_events`, written in the same transaction as each transition |

Validation failures (`REJECTED`, synchronous 422 at `/complete`) are deliberately separate from pipeline failures
(`FAILED`, asynchronous, always has a stage).

## 4. The three services

| Service | Input → output | Records | Failure classes |
|---|---|---|---|
| **convert** | `originals/…` → `normalized.jpg`: magic-byte sniff, **pixel check from the header before any decode**, HEIC→JPEG via `heic-convert`, EXIF rotate, sRGB, flatten alpha, metadata stripped, q95 4:4:4 | format, original bytes, dimensions | `UNSUPPORTED_FORMAT`, `CORRUPT`, `TOO_MANY_PIXELS`, `SOURCE_MISSING` are permanent |
| **compress** | `normalized.jpg` → `master.jpg`: mozjpeg q80, progressive, full resolution | compressed bytes, ratio vs. upload, quality | `INTERMEDIATE_MISSING` is permanent (reprocess restarts at convert). A decode failure here is our bug, so it's transient |
| **variants** | `master.jpg` → `thumb` (320² attention crop), `web` (≤1600px), `full` (the master, S3 server-side copy, no re-encode) | 3 rows: key, dimensions, bytes, format | transient only |

Each service is `services/<name>/src/handler.ts` (pure: S3 in, S3 out, no DB) plus a one-line entrypoint calling
`runWorker(stage, handler)`. Retries, leases, fencing, timeouts, heartbeats and shutdown live once, in
`packages/core/src/worker.ts`.

**Error classification is by origin, not by message text.** Handlers wrap the decode of *user input* in
`PermanentError`. Everything else (S3, Postgres, timeouts, our own bugs) is transient and gets retried with
exponential backoff and jitter (~1s, ~2s, ~4s), up to 3 attempts. After that the image is FAILED with
`PROCESSING_FAILED` / `TIMED_OUT`, `retryable: true`. Permanent errors never retry.

## 5. Idempotency (at-least-once in, effectively-once out)

We never claim exactly-once *processing*. A stage can run twice, for example if a worker stalls past its lease
and another replica reclaims the task. The **outcome** is still once:

| Stage | Duplicate delivery | Two workers at once | Duplicate S3 objects | Duplicate DB rows | Next stage enqueued twice |
|---|---|---|---|---|---|
| convert | reclaim after lease expiry; the late writer is fenced | impossible: `SKIP LOCKED` claim | no: deterministic key, overwritten with equivalent bytes | no: conditional update on `(id, run, PROCESSING)` | no: unique index + `ON CONFLICT` |
| compress | same | same | same | same | same |
| variants | same | same | no: 3 fixed keys | no: PK `(image_id, name)` upsert | n/a (terminal) |

Reprocessing bumps `images.run` (the fencing token) with a conditional update on the run that was read. If two
reprocess calls race, one creates run N+1 and the other just returns it. Old variant rows stay visible (flagged
`current: false`) until the new run's completion transaction replaces them, so the gallery never goes blank.

## 6. Failure scenarios

| # | Scenario | What happens |
|---|---|---|
| S1 | Same task delivered twice | The equivalent here is a lease expiry plus reclaim. The second worker redoes the stage. The first worker's completion fails the `locked_by` check and writes nothing (`queue.test.ts`) |
| S2 | Two workers claim the same task | `FOR UPDATE SKIP LOCKED`: exactly one gets it (`queue.test.ts`) |
| S3 | Crash after claim, before S3 upload | The lease (30s, renewed every 10s) expires, another replica reclaims it, and the attempt counts |
| S4 | Crash after S3 upload, before the DB update | Reclaimed and redone. Same key, so it overwrites. No orphan, no duplicate |
| S5 | DB commit OK but enqueueing the next stage fails | **Impossible**: same transaction |
| S6 | Next-stage enqueue happens twice | `ON CONFLICT DO NOTHING` on `(image, run, stage)` and on one-active-task-per-image |
| S7 | Variant 1 OK, variant 2 fails, variant 3 never starts | One task. Rows are only written in the completion transaction, so nothing partial is visible. The retry overwrites the same keys |
| S8 | Reprocess called twice at once | Conditional update on the observed `run`: one winner, both get 202 with the same run |
| S9 | Permanently invalid image retried repeatedly | Fails at once with no retries, `retryable: false`. Reprocess returns 422 unless `force=true` |
| S10 | Small file that decodes to a huge pixel buffer | `sharp.metadata()` reads dimensions from the header (HEIC too, from the HEIF container) and rejects >100 MP **before** `heic-convert` or libvips decode anything. `limitInputPixels` is a second guard |
| S11 | 10,000 images arrive faster than workers drain | Admission returns 429 + `Retry-After` once active tasks across all stages pass the watermark (400). The queue stays bounded and clients back off (§7) |
| S12 | One stage becomes 10× slower | Its queue and oldest-age grow. Total in-flight hits the watermark and the API sheds load. Scale that stage alone: `pnpm scale variants=4` |

## 7. Backpressure and scaling

The chain, from edge to core:
1. **Admission (API).** It refuses new work with 429 + `Retry-After` when either limit is hit:
   - active tasks across **all** stages ≥ `GLOBAL_MAX_IN_FLIGHT`
   - the user's UPLOADING+PROCESSING images ≥ `USER_MAX_IN_FLIGHT`

   Counting every stage means a slow *downstream* stage still sheds load at the edge. Both are soft limits
   (count-then-insert can overshoot by the number of concurrent requests), which is a deliberate choice over a
   hot counter row.
2. **Pull-based workers.** A replica claims only as many tasks as it has free slots, with no prefetch, so a slow
   stage builds a queue in Postgres, not in memory. A slot stays occupied until the libvips work really ends,
   even after a timeout, because libvips can't be cancelled and freeing the slot early would oversubscribe the CPU.
3. **Bounded memory per replica.** The pixel limit is checked before decode. Concurrency defaults are convert 1
   (a 48 MP HEIC is ~200 MB of RGBA in wasm), compress 2, variants 2. The libvips cache is off, there's a
   `SHARP_THREADS` cap, and the S3 object size is capped before it's buffered.
4. **The client.** The load test (and any well-behaved client) honours `Retry-After` with jitter.

**What happens at each volume** (local, 1 replica per stage, ~3 images/s):

| Arrivals | What you see |
|---|---|
| 10 | All admitted. Convert's queue holds a few, each stage drains in seconds |
| 100 | All admitted (under the 400 watermark). The slowest stage's queue and age grow, then drain. End-to-end p95 ≈ backlog / throughput |
| 1,000 | About 400 are admitted, then 429s. Clients retry with jitter, and admission tracks the drain rate. Queue age stays bounded instead of growing forever |
| 10,000 | Same as 1,000 for longer. Throughput is set by the slowest stage × its replicas. Adding replicas to *that* stage raises the drain rate until the laptop's cores (or the DB pool) saturate |

**The scaling signal is the oldest queued task's age per stage** (`/api/admin/stats`, the Pipeline tab), not
depth. Age maps directly to a latency SLO. In production that drives per-stage autoscaling (KEDA / ECS target
tracking on queue age). Every stage scales on its own: `pnpm scale variants=3` adds replicas live without touching
the others. SIGTERM drains in-flight work, then releases unfinished leases back to QUEUED, so scale-in loses
nothing.

**Ceilings:**
- The DB connection count (replicas × `connection_limit`). PgBouncer is the fix.
- Claim polling (idle replicas back off to one indexed query every 2s). LISTEN/NOTIFY is the fix.
- Locally, the cores are shared: every replica runs on the same laptop.

## 8. Observability

- **Structured JSON logs** on every task transition: `imageId, run, stage, attempt, workerId, durationMs, errorCode, inBytes, outBytes`.
- **`/api/admin/stats`**, per stage:
  - queued, retrying, running/slots
  - oldest wait
  - done/min
  - p50/p95/p99
  - FAILED count (the DLQ equivalent)
  - live replicas from the `workers` registry

  Plus admission: in flight vs the watermark, and 429s in the last minute.
- **`image_events`**: a per-image timeline (queued → started on worker X → retry scheduled → done in N ms), shown in the UI.

**Runbook: "100 images are stuck".**
1. Look at the Pipeline tab. Which stage has the old `oldest wait`? Does it have replicas?
2. If replicas are 0 or draining, start some: `pnpm scale <stage>=2`.
3. If replicas exist but `running` is 0: `SELECT last_error, count(*) FROM tasks WHERE status='QUEUED' AND attempts>0 GROUP BY 1` shows retry storms, for example S3 credentials.
4. If tasks are RUNNING with old `locked_at`, a worker is wedged. The lease expires in ≤30s and another replica reclaims; the sweeper fails final attempts.
5. `pnpm check` confirms no invariant is broken.
6. For FAILED tasks (the DLQ): `SELECT error_code, count(*) FROM images WHERE status='FAILED' GROUP BY 1`. Reprocess the retryable ones.

## 9. Testing

| What | How |
|---|---|
| Claim exclusivity, zombie fencing, duplicate enqueue, crash reclaim, retry budget, sweep to TIMED_OUT, idempotent variant upsert | `packages/core/src/queue.test.ts` against real Postgres (stop workers first) |
| Sniffing, state derivation, error classification, backoff, key layout | `packages/core/src/pure.test.ts` |
| System invariants after any run | `pnpm check [--sample N]`, which also asserts exactly 3 S3 objects per image and no EXIF/GPS in variants |
| Load + backpressure + scaling | `pnpm loadtest`, which ends by running the invariant check |
