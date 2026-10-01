# Security

The main attack surface is the **decoder**. Every image is untrusted bytes fed into libheif and libvips, so the
convert service is treated as the high-risk component, and the stages are isolated by S3 prefix and IAM.

| Threat | Control | Where | Proven by |
|---|---|---|---|
| Spoofed type (HTML/script uploaded as `.jpg`) | Magic bytes decide the format (at `/complete` via a 32-byte ranged GET, and again in convert). The declared `Content-Type` is only used for the upload policy | `core/sniff.ts`, `images.service.ts`, `convert/handler.ts` | `pure.test.ts`, fixture `not-an-image.jpg` → 422 REJECTED |
| Oversized uploads | Presigned POST policy `content-length-range` (S3 itself refuses), plus HeadObject size check, plus a size cap before buffering in workers | `core/s3.ts` | upload > 50 MB is refused by S3 |
| Decompression / pixel bombs | Dimensions are read from the header **before** decode (HEIC too: from the HEIF container, which matters because `heic-convert` has no pixel limit). Reject > 100 MP. `limitInputPixels` on every libvips decode | `convert/handler.ts`, `core/imaging.ts` | fixture `pixel-bomb.png` (144 MP in 450 KB) → FAILED `TOO_MANY_PIXELS` |
| Malformed / truncated images | `failOn: 'error'`, classified permanent `CORRUPT` (no retry storm) | `convert/handler.ts` | fixture `corrupt.jpg` |
| Hung decode | Per-task timeout (120s). The slot is held until the work really ends, so a stuck decode can't oversubscribe the replica | `core/worker.ts` | `TIMED_OUT` path in `queue.test.ts` |
| Path traversal / malicious filenames | Keys contain only server-generated UUIDs. Filename is display-only, control chars stripped, capped at 255 | `core/keys.ts` | `pure.test.ts` |
| EXIF/GPS leakage | Every served file is a re-encode without metadata (`full` is a copy of the re-encoded master) | `convert`, `compress` | `pnpm check --sample N` asserts no EXIF/XMP/IPTC in variants |
| Polyglot served as HTML | Raw originals are never served. Presigned GETs force `ResponseContentType=image/jpeg`, `inline`. 20-min TTL | `core/s3.ts` | — |
| Cross-user access (IDOR) | Every query is filtered by `user_id` from the identity cookie. Another user's id is **404, not 403** (no enumeration). Same for reprocess | `images.service.ts` | — |
| Reprocess as a CPU amplifier | Only on owned images in a terminal state. COMPLETE needs `force`. Non-retryable needs `force`. 30/min per user | `images.service.ts`, `routes.ts` | — |
| Flooding the pipeline | Admission control (global + per-user in-flight caps → 429 + Retry-After), plus a fixed-window rate limit per user+IP | `admission.ts`, `rateLimit.ts` | `pnpm loadtest` shows 429s |
| Internal details in errors | Users see a curated `{stage, code, message, retryable}`. Raw errors stay in `tasks.last_error` and the logs. The timeline shows "attempt 1 failed, retrying in 2s", not the stack | `core/errors.ts`, `core/queue.ts` | — |
| Operator endpoint exposure | `/api/admin/*` needs `x-admin-token` (constant-time compare). Disabled (404) when unset. The dev proxy injects it server-side, so it never ships in the JS bundle | `routes.ts`, `apps/web/vite.config.ts` | — |
| Data in transit / at rest | Bucket policy denies non-TLS (`aws:SecureTransport`). Block Public Access. SSE-S3 | bucket config | — |
| Least privilege | Per-service IAM policies by prefix: convert can't write `variants/`, the only served prefix. Only the variants service writes it, and it only reads JPEGs we encoded ourselves | `infra/iam/*.json` | (see note) |
| Browser | CSP that only allows our bucket for `img-src`/`connect-src`, `nosniff`, `frame-ancestors 'none'`. Helmet on the API with `default-src 'none'` | `vite.config.ts`, `server.ts` | — |
| Secrets | `.env` is git-ignored, `.env.example` has no values, nothing is logged | — | — |

**Honest gaps (documented, not built):**
- **Auth** is an anonymous httpOnly cookie, as in Part 1. Every query is already scoped by user, so real auth only replaces the `identity` middleware.
- **Least privilege is designed, not exercised locally.** All local processes share one dev credential with `infra/iam-policy.dev.json`. In production each service runs under its own role from `infra/iam/`.
- **No containers** in this submission (local demo), so there's no non-root user or cgroup memory/CPU limits yet. They'd be set per service (convert gets the most memory).
- **No malware/AV scanning** before decode. Per-service DB roles (workers only need `tasks`/`images`/`variants`) are not set up.
- Run `pnpm audit` before deploying. Dependency scanning would belong in CI.
