import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

const env = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: int(4000),
    DATABASE_URL: z.string().default(''),
    AWS_REGION: z.string().default(''),
    S3_BUCKET: z.string().default(''),
    ADMIN_TOKEN: z.string().default(''),

    // Worker (each replica)
    WORKER_CONCURRENCY: z.coerce.number().int().positive().optional(),
    WORKER_POLL_MIN_MS: int(200),
    WORKER_POLL_MAX_MS: int(2000),
    WORKER_LEASE_MS: int(30_000),
    WORKER_TASK_TIMEOUT_MS: int(120_000),
    WORKER_MAX_ATTEMPTS: int(3),
    WORKER_DRAIN_MS: int(25_000),
    WORKER_DB_POOL: int(4),

    // Admission control (API)
    USER_MAX_IN_FLIGHT: int(100),
    GLOBAL_MAX_IN_FLIGHT: int(400),

    // Limits
    MAX_BYTES: int(50 * 1024 * 1024),
    MIN_BYTES: int(1024),
    MAX_INPUT_PIXELS: int(100_000_000),

    // Failure injection for the demo: CHAOS_FAIL_STAGE=compress makes that stage throw transient errors.
    CHAOS_FAIL_STAGE: z.string().default(''),
    CHAOS_FAIL_RATE: z.coerce.number().min(0).max(1).default(1),
  })
  .parse(process.env);

/** Per-stage default concurrency. Convert is 1: a 48 MP HEIC decodes to ~200 MB of RGBA inside wasm. */
const defaultConcurrency = { CONVERT: 1, COMPRESS: 2, VARIANTS: 2 } as const;

export const config = {
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  adminToken: env.ADMIN_TOKEN,
  pipelineVersion: 'v1',
  s3: {
    region: env.AWS_REGION,
    bucket: env.S3_BUCKET,
    presignUploadTtlSeconds: 10 * 60,
    /** Read URLs are signed against a time bucket so they stay identical (and ETags stable) within it. */
    readUrlTtlSeconds: 20 * 60,
    readUrlBucketSeconds: 5 * 60,
  },
  worker: {
    concurrency: (stage: keyof typeof defaultConcurrency) => env.WORKER_CONCURRENCY ?? defaultConcurrency[stage],
    pollMinMs: env.WORKER_POLL_MIN_MS,
    pollMaxMs: env.WORKER_POLL_MAX_MS,
    leaseMs: env.WORKER_LEASE_MS,
    taskTimeoutMs: env.WORKER_TASK_TIMEOUT_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    drainMs: env.WORKER_DRAIN_MS,
    dbPool: env.WORKER_DB_POOL,
    sweepIntervalMs: 15_000,
    registryIntervalMs: 2_000,
  },
  admission: {
    userMaxInFlight: env.USER_MAX_IN_FLIGHT,
    globalMaxInFlight: env.GLOBAL_MAX_IN_FLIGHT,
    abandonedUploadMs: 60 * 60 * 1000,
  },
  limits: {
    maxBytes: env.MAX_BYTES,
    minBytes: env.MIN_BYTES,
    maxInputPixels: env.MAX_INPUT_PIXELS,
  },
  chaos: { stage: env.CHAOS_FAIL_STAGE.toUpperCase(), rate: env.CHAOS_FAIL_RATE },
} as const;
