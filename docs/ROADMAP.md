# Roadmap

These were deliberately left out of the time-boxed build. Each row says what we'd do and **what would trigger it**,
so none of it is speculative work. Most items plug into an existing seam rather than needing a rewrite.

| # | Area | Today | Next | Trigger |
|---|---|---|---|---|
| 1 | Queue | Postgres `tasks` + `SKIP LOCKED` | SQS per stage + DLQ per stage, **with a transactional outbox** for the stage handoff (the outbox becomes mandatory once DB and queue are separate systems) | Sustained thousands of jobs/min, or claim queries visible in DB load |
| 2 | Deploy / autoscale | Local processes via `pnpm scale` | One container image per service (`USER node`, memory/CPU limits, `MALLOC_ARENA_MAX=2` for glibc + libvips), ECS/K8s with KEDA scaling **each stage on oldest-task age** | First real deployment |
| 3 | Fairness | Per-user in-flight cap | True fair queuing across users (virtual-time ordering on claim), so a heavy user's backlog interleaves with others instead of running FIFO | Multi-tenant traffic with very uneven users |
| 4 | Inter-stage backpressure | Global watermark counts all stages | A stage pauses claiming while the next stage's queue is above a high-water mark (bounds intermediate storage, not just latency) | Intermediates in `work/` growing large during incidents |
| 5 | Worker memory | Concurrency counts tasks | Pixel-weighted semaphore (reserve slots by width×height from the header), so one 48 MP HEIC counts as several small JPEGs | OOMs or wide variance in input sizes |
| 6 | Status push | Polling with ETag/304 | SSE fed by Postgres `LISTEN/NOTIFY`, which also replaces idle claim polling | Poll traffic dominates API load |
| 7 | Delivery | Presigned S3 GETs | CloudFront + signed cookies, **immutable versioned keys** (`…/r{run}/web.jpg`) so variants can be cached forever, with the previous run's prefix GC'd after the swap | Gallery traffic, global users |
| 8 | Formats | JPEG everywhere | AVIF/WebP variants negotiated by `Accept`, and SSIM-targeted adaptive quality per image | Bandwidth cost |
| 9 | DLQ tooling | FAILED tasks queryable, per-image reprocess | Bulk replay: `POST /admin/reprocess?stage=&code=&since=`, plus "reprocess everything made by pipeline_version v1" | First incident with many failures |
| 10 | Deletion / GDPR | Not implemented | `DELETING` tombstone that fences in-flight workers (a completion into a tombstone deletes its own outputs), then the per-image S3 prefixes are swept | Before handling real user data |
| 11 | Data layer | Single Postgres, small pools | PgBouncer (transaction mode), partition `tasks`/`image_events` by month, archive DONE tasks | Connection pressure, table > ~50M rows |
| 12 | Security | Anonymous cookie, one dev credential | Real auth, per-service IAM roles (`infra/iam/`), per-service DB roles, AV scanning before decode, CI dependency scanning | Before any public launch |
| 13 | Observability | JSON logs, `/admin/stats`, `image_events` | OpenTelemetry traces across API → stages (trace id carried on the task row), Prometheus metrics, alerts on queue age and FAILED rate | First on-call rotation |
| 14 | Validation | Light gate at `/complete` (exists, size, magic bytes) | Part 1's content validator (faces, blur, duplicates) as a stage *before* convert, through the same seam | Product decision |
