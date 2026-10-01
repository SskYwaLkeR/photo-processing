# Media Processing Pipeline

A validated image goes through three independently scalable, stateless services:

- **convert:** normalize the format, with HEIC → JPEG
- **compress:** mozjpeg, tracking size and compression ratio
- **variants:** thumb, web and full, stored in S3

Users can follow each stage as it happens, retrieve the variants with URLs and metadata, and see a structured
reason when something fails. Reprocessing is safe to repeat, and a load test shows how the system queues, sheds
load and scales.

- **Architecture, state machine, idempotency, failure scenarios, backpressure:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Threat model:** [docs/SECURITY.md](docs/SECURITY.md)
- **What's deliberately not built, and what would trigger building it:** [docs/ROADMAP.md](docs/ROADMAP.md)

## Architecture in one minute

```
API ──enqueue──▶ [convert ×a] ──▶ [compress ×b] ──▶ [variants ×c]
 │  429+Retry-After     │               │                │
 │                      └──── Postgres: images · tasks (row = job) · variants · events ────┘
 └─ presigned POST ──▶ S3: originals/ → work/{normalized,master}.jpg → variants/{thumb,web,full}.jpg
```

- **S3 holds the bytes, Postgres holds state and pending work, workers hold nothing.** You can kill any process at any time: its lease expires and another replica picks up the task.
- **The queue is a Postgres table, on purpose.** Finishing a stage and enqueuing the next one happen in *one transaction*, so "stage done but next stage never queued" can't happen, and no outbox is needed. SQS plus an outbox is the documented next step once throughput needs it ([ARCHITECTURE §2](docs/ARCHITECTURE.md#2-why-the-queue-is-postgres-a-deliberate-deviation)).
- **Effectively-once outcomes on top of at-least-once processing:**
  - `SKIP LOCKED` claims, so two workers can't take the same task
  - every write is fenced on `(locked_by, run)`, so a stale worker writes nothing
  - unique `(image, run, stage)` plus one active task per image, so nothing is enqueued twice
  - deterministic S3 keys, and variants upserted on `(image_id, name)`, so there are never duplicate variants
- **Backpressure runs end to end:**
  - pull-based workers only take as many tasks as they have free slots
  - admission control returns 429 with `Retry-After` once in-flight work across **all** stages passes a watermark, or a per-user cap
  - the load test client honours `Retry-After`

## Setup

You need Node 22 (pinned in `.nvmrc`; sharp 0.35 breaks on Node 20.9), pnpm 10, Postgres 16, an S3 bucket, and macOS for HEIC fixtures.

```bash
nvm use
```

```bash
pnpm install
```

```bash
createdb aragon_pipeline
```

```bash
cp .env.example .env
```

Fill in `.env`:
- `DATABASE_URL` must include your OS user, for example `postgresql://you@localhost:5432/aragon_pipeline`. Without it, Prisma connects as `postgres`.
- `AWS_*` and `S3_BUCKET`.
- `ADMIN_TOKEN`.

**S3 bucket (private):**
- Block Public Access: on.
- CORS: [infra/s3-cors.json](infra/s3-cors.json) (POST/GET from `localhost:5173`).
- Bucket policy (TLS only): [infra/s3-bucket-policy.json](infra/s3-bucket-policy.json).
- IAM for the dev credential: [infra/iam-policy.dev.json](infra/iam-policy.dev.json). Per-service least-privilege versions are in [infra/iam/](infra/iam/).
- Optional lifecycle rule (expire `work/` after 7 days): [infra/lifecycle-rule.json](infra/lifecycle-rule.json).

Then apply the migration. It includes the raw-SQL CHECK constraints and partial unique indexes:

```bash
pnpm db:migrate
```

Generate the demo and load-test images:

```bash
pnpm fixtures
```

## Run

Everything at once (API, web, and 1 replica of each service):

```bash
pnpm dev
```

Or run each part separately, which you need for the scaling and failure demos. Each command goes in its own terminal:

```bash
pnpm api
```

```bash
pnpm web
```

```bash
pnpm scale convert=1 compress=1 variants=1
```

Open http://localhost:5173. **My images** is the user view. **Pipeline** is the operator view: per-stage queue depth, oldest wait, done/min, p50/p95, FAILED (the dead-letter count), and live replicas.

Every service is just a process. `pnpm scale variants=3` in another terminal adds three more variants replicas live and leaves the other stages alone. Ctrl-C drains in-flight work, then hands unfinished leases back. A second Ctrl-C hard-kills, which simulates a crash: those leases expire and another replica reclaims the work.

## Demo scenarios

| Scenario | How | Expected |
|---|---|---|
| Happy path | Drop `fixtures/photo-12mp.jpg`, `screenshot.png`, `iphone.heic` | Convert → Compress → Variants. Expand the row to see thumb/web/full with dimensions, bytes, compression ratio and the timeline |
| Permanent failure | Drop `fixtures/corrupt.jpg` / `pixel-bomb.png` | FAILED at convert with `CORRUPT` / `TOO_MANY_PIXELS`, no retries, no Reprocess button. The bomb (144 MP in 450 KB) is caught from the header before anything decodes |
| Validation reject | Drop `fixtures/not-an-image.jpg` | 422 at upload, REJECTED `UNSUPPORTED_FORMAT`. Never enters the pipeline |
| Transient failure → reprocess | Run compress with `CHAOS_FAIL_STAGE=compress pnpm scale compress=1`, upload, then restart compress normally and click **Reprocess** | Retries after ~1s and ~2s, then FAILED at compress (`PROCESSING_FAILED`, retryable). Reprocess starts **run 2 from compress**, so convert isn't redone, and completes with exactly 3 variants |
| Reprocess is idempotent | Click **Regenerate** on a completed image several times | Still exactly 3 variant rows and 3 S3 objects (`pnpm check --sample 5`) |
| Crash recovery | Ctrl-C twice on a `pnpm scale` terminal while it's busy | That worker's tasks are reclaimed by another replica within the 30s lease. Final-attempt expiry ends as `TIMED_OUT`, never stuck |

## Load test

Send 300 images through the real path (create → presigned POST to S3 → complete → poll), with 40 concurrent submitters and 10 virtual users:

```bash
pnpm loadtest -n 300 -c 40 -u 10
```

The same, but one user submits half of everything (fairness check):

```bash
pnpm loadtest -n 400 -c 60 --noisy
```

How the load test behaves:
- **Concurrency is bounded:** a fixed pool of submitters, not an unbounded `Promise.all`.
- **Duplicates can't happen:** every submit carries an `Idempotency-Key`.
- **429s are honoured** with `Retry-After` plus jitter.

It prints a live per-stage queue table, then a report:
- outcome by state and error code
- 429 count
- end-to-end avg/p50/p95/p99/max
- submit latency
- throughput
- queue-depth and queue-age peaks per stage

It finishes by running `pnpm check`. Each run is saved to `loadtest-results/`.

**Suggested scaling walk-through:** run with `convert=1 compress=1 variants=1`, and the Pipeline tab shows convert's oldest wait climbing (convert runs one task per replica). Then `pnpm scale convert=3` in another terminal. The backlog drains faster and the bottleneck moves downstream.

**Results** (MacBook, eu-central-1 bucket, 1 replica per stage vs. scaled):

| Run | Images | Replicas (convert/compress/variants) | Throughput | e2e p50 / p95 / p99 | 429s |
|---|---|---|---|---|---|
| _to fill in_ | | 1/1/1 | | | |
| _to fill in_ | | 3/1/2 | | | |

**What this proves:**
- correctness under concurrency: invariants hold after hundreds of overlapping tasks
- that a slow stage builds a bounded queue instead of failing
- that admission sheds load with 429s
- that adding replicas to the bottleneck stage raises throughput

**What it doesn't prove:**
- **Production throughput.** All replicas share one laptop's cores, and every stage round-trips multi-MB objects to S3 over home internet, so S3 latency dominates small images.
- **Behaviour past the DB connection ceiling** (replicas × pool), which is where PgBouncer comes in.

## Tests

Unit tests, plus the queue's race and failure tests against real Postgres. Stop the workers first:

```bash
pnpm test
```

Typecheck every package and script:

```bash
pnpm typecheck
```

Invariant check after any run (`--sample N` also inspects S3 objects and EXIF):

```bash
pnpm check --sample 5
```

The queue tests cover:
- claim exclusivity
- zombie-worker fencing
- duplicate enqueue
- crash reclaim
- the retry budget, then a retryable failure
- final-lease expiry → `TIMED_OUT`
- idempotent variant upserts across runs

## Project layout

```
packages/core/       shared: queue (claim/complete/fail/release/sweep), worker loop, S3, keys, errors, config
  prisma/            schema + migration (CHECKs and partial indexes appended as raw SQL)
services/convert/    handler.ts: sniff, pixel check, HEIC decode, normalize
services/compress/   handler.ts: mozjpeg master + ratio
services/variants/   handler.ts: thumb / web / full (server-side copy)
apps/api/            Express 5: admission, idempotent submit, validation gate, reprocess policy, stats
apps/web/            Vite + React: My images + Pipeline views
scripts/             scale.ts, loadtest.ts, check.ts, make-fixtures.mjs
infra/               IAM (dev + per-service), bucket CORS/policy, lifecycle rule
```

## Tradeoffs worth knowing

- **A Postgres queue instead of SQS.** You get a transactional handoff and one source of truth. The cost is claim polling on the main DB and connection count as the ceiling. It's swappable behind `core/queue.ts`.
- **JPEG everywhere.** It's simple and universally supported, but **HEIC sources get bigger** (HEVC beats JPEG; the UI says so). AVIF/WebP negotiation is on the roadmap.
- **Concurrency counts tasks, not pixels.** Convert defaults to 1 per replica, because a 48 MP HEIC is ~200 MB of RGBA inside wasm. A pixel-weighted semaphore is the upgrade.
- **Fixed quality q80.** SSIM-targeted adaptive quality would compress better.
- **Soft admission limits.** Count-then-insert can overshoot by the number of concurrent requests. A hard cap needs a hot counter row.
- **Anonymous cookie identity and one shared dev AWS credential.** Every query is scoped by user, and the per-service IAM policies are written but not enforced locally.
- **No Docker.** This is a local demo. Each service is already a single entrypoint configured only by env, so containerizing it is mechanical ([ROADMAP #2](docs/ROADMAP.md)).
