/**
 * Load test through the real path: POST /images → presigned POST to S3 → /complete → poll to terminal.
 *
 *   pnpm loadtest -n 300 -c 40 -u 10          # 300 images, 40 concurrent submitters, 10 virtual users
 *   pnpm loadtest -n 400 -c 60 --noisy        # one user submits half of everything (fairness check)
 *
 * Concurrency is bounded (a fixed pool of submitters, never an unbounded Promise.all). 429s are honoured
 * with Retry-After + jitter, so the client is part of the backpressure loop. Every submit carries an
 * Idempotency-Key, so a retried POST can't create a duplicate image. Ends with the invariant checker.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '@pipeline/core/config';
import { db } from '@pipeline/core/prisma';
import { runChecks } from './check';

const { values: args } = parseArgs({
  options: {
    n: { type: 'string', short: 'n', default: '200' },
    c: { type: 'string', short: 'c', default: '30' },
    u: { type: 'string', short: 'u', default: '10' },
    api: { type: 'string', default: `http://localhost:${config.port}` },
    fixtures: { type: 'string', default: 'fixtures/load' },
    timeout: { type: 'string', default: '900' },
    noisy: { type: 'boolean', default: false },
  },
});
const N = Number(args.n);
const C = Number(args.c);
const U = Number(args.u);
const API = args.api!;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'REJECTED']);
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Job {
  i: number;
  user: number;
  file: { name: string; mime: string; bytes: Buffer };
  id?: string;
  submittedAt?: number;
  acceptedAt?: number;
  doneAt?: number;
  state?: string;
  errorCode?: string;
  clientError?: string;
}

// ── virtual users (one cookie jar each) ────────────────────────────────────────────────────────────
const cookies: (string | undefined)[] = Array.from({ length: U });
let throttled = 0;
const throttledByCode: Record<string, number> = {};

let networkRetries = 0;

/**
 * Transient transport failures (socket reset, S3 RequestTimeout / 5xx on a saturated uplink) are
 * retried with backoff, like any real client. Safe: every call here is idempotent (same key, same
 * Idempotency-Key, /complete is a no-op when repeated).
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || (err as { fatal?: boolean }).fatal) throw new Error(`${label}: ${(err as Error).message}`);
      networkRetries++;
      await sleep(500 * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
}

class Retryable extends Error {}

async function api(user: number, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await withRetry(`${method} ${url.split('?')[0]}`, () => fetch(`${API}${url}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookies[user] ? { cookie: cookies[user]! } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('uid='));
    if (setCookie) cookies[user] = setCookie.split(';')[0];
    if (res.status === 429 && attempt < 200) {
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      throttled++;
      const code = json.error?.code ?? 'RATE_LIMITED';
      throttledByCode[code] = (throttledByCode[code] ?? 0) + 1;
      const retryAfter = Number(res.headers.get('retry-after') ?? 2);
      await sleep(retryAfter * 1000 * (0.5 + Math.random())); // jitter: don't come back as a herd
      continue;
    }
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  }
}

async function submit(job: Job) {
  job.submittedAt = Date.now();
  const created = await api(job.user, 'POST', '/api/images', { filename: job.file.name, mimeType: job.file.mime, sizeBytes: job.file.bytes.length }, {
    'idempotency-key': `lt-${runId}-${job.i}`,
  });
  if (created.status >= 300) throw new Error(`create ${created.status} ${created.json?.error?.code}`);
  job.id = created.json.image.id;

  await withRetry('s3 upload', async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(created.json.upload.fields as Record<string, string>)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(job.file.bytes)], { type: job.file.mime }), job.file.name);
    const up = await fetch(created.json.upload.url, { method: 'POST', body: form });
    if (!up.ok) {
      const code = (await up.text()).match(/<Code>(\w+)<\/Code>/)?.[1] ?? '';
      const message = `${up.status} ${code}`.trim();
      if (up.status >= 500 || code === 'RequestTimeout') throw new Retryable(message);
      throw Object.assign(new Error(message), { fatal: true });
    }
  });

  const done = await api(job.user, 'POST', `/api/images/${job.id}/complete`);
  if (done.status === 422) {
    job.state = 'REJECTED';
    job.errorCode = done.json?.error?.code;
    job.doneAt = Date.now();
  } else if (done.status >= 300) throw new Error(`complete ${done.status}`);
  job.acceptedAt = Date.now();
}

// ── stats sampling ─────────────────────────────────────────────────────────────────────────────────
type Stats = { stages: { stage: string; queued: number; running: number; oldestQueuedMs: number; replicas: number; p95Ms: number; doneLastMinute: number; failed: number }[]; admission: { inFlight: number } };
const peaks: Record<string, { queued: number; oldestMs: number; replicas: number }> = {};
let lastStats: Stats | undefined;

async function sampleStats(): Promise<Stats | undefined> {
  if (!config.adminToken) return undefined;
  try {
    const res = await fetch(`${API}/api/admin/stats`, { headers: { 'x-admin-token': config.adminToken } });
    if (!res.ok) return undefined;
    const stats = (await res.json()) as Stats;
    for (const s of stats.stages) {
      const p = (peaks[s.stage] ??= { queued: 0, oldestMs: 0, replicas: 0 });
      p.queued = Math.max(p.queued, s.queued);
      p.oldestMs = Math.max(p.oldestMs, s.oldestQueuedMs);
      p.replicas = Math.max(p.replicas, s.replicas);
    }
    return (lastStats = stats);
  } catch {
    return undefined;
  }
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0);
const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

// ── run ────────────────────────────────────────────────────────────────────────────────────────────
const runId = randomUUID().slice(0, 8);
const files = await Promise.all(
  (await readdir(args.fixtures!))
    .filter((f) => MIME[path.extname(f).toLowerCase()])
    .sort()
    .map(async (name) => ({ name, mime: MIME[path.extname(name).toLowerCase()]!, bytes: await readFile(path.join(args.fixtures!, name)) })),
);
if (files.length === 0) throw new Error(`no fixtures in ${args.fixtures} — run pnpm fixtures`);

const jobs: Job[] = Array.from({ length: N }, (_, i) => ({
  i,
  user: args.noisy && i % 2 === 0 ? 0 : (i % (U - (args.noisy ? 1 : 0))) + (args.noisy ? 1 : 0),
  file: files[i % files.length]!,
}));
const totalBytes = jobs.reduce((n, j) => n + j.file.bytes.length, 0);
console.log(`run ${runId}: ${N} images (${(totalBytes / 1e6).toFixed(1)} MB) · ${C} concurrent submitters · ${U} users${args.noisy ? ' · noisy neighbour = user 0' : ''}`);

// Each virtual user gets its identity cookie before any concurrent request; otherwise parallel first
// requests would each mint a different uid and later calls would (correctly) 404 on "someone else's" image.
await Promise.all(cookies.map((_, user) => api(user, 'GET', '/api/health')));

const started = Date.now();
let next = 0;
const submitters = Array.from({ length: C }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    try {
      await submit(job);
    } catch (err) {
      job.clientError = (err as Error).message;
      job.doneAt = Date.now();
    }
  }
});

// Poll in-flight images per user, 100 ids per request, like the UI does.
let polling = true;
const poller = (async () => {
  while (polling) {
    await sleep(1000);
    const inFlight = jobs.filter((j) => j.id && j.acceptedAt && !j.doneAt);
    const byUser = new Map<number, Job[]>();
    for (const j of inFlight) byUser.set(j.user, [...(byUser.get(j.user) ?? []), j]);
    await Promise.all(
      [...byUser].map(async ([user, list]) => {
        for (let k = 0; k < list.length; k += 100) {
          const chunk = list.slice(k, k + 100);
          const res = await api(user, 'GET', `/api/images?ids=${chunk.map((j) => j.id).join(',')}`);
          for (const item of res.json.items ?? []) {
            const job = chunk.find((j) => j.id === item.id);
            if (job && TERMINAL.has(item.state)) {
              job.state = item.state;
              job.errorCode = item.error?.code;
              job.doneAt = Date.now();
            }
          }
        }
      }),
    );
  }
})();

const monitor = setInterval(async () => {
  const done = jobs.filter((j) => j.doneAt).length;
  const submitted = jobs.filter((j) => j.acceptedAt).length;
  const st = await sampleStats();
  const stages = st?.stages.map((x) => `${x.stage.toLowerCase()} q=${x.queued} run=${x.running} age=${s(x.oldestQueuedMs)} ×${x.replicas}`).join(' │ ') ?? '';
  console.log(`[${s(Date.now() - started).padStart(7)}] submitted ${submitted}/${N} done ${done}/${N} 429s ${throttled} │ ${stages}`);
}, 2000);

await Promise.all(submitters);
const deadline = Date.now() + Number(args.timeout) * 1000;
while (jobs.some((j) => !j.doneAt) && Date.now() < deadline) await sleep(500);
polling = false;
await poller;
clearInterval(monitor);
await sampleStats();

// ── report ─────────────────────────────────────────────────────────────────────────────────────────
const finished = Date.now();
const e2e = jobs.filter((j) => j.state === 'COMPLETED').map((j) => j.doneAt! - j.submittedAt!).sort((a, b) => a - b);
const submitLat = jobs.filter((j) => j.acceptedAt).map((j) => j.acceptedAt! - j.submittedAt!).sort((a, b) => a - b);
const byState = jobs.reduce<Record<string, number>>((acc, j) => {
  const k = j.clientError ? 'CLIENT_ERROR' : j.state ? `${j.state}${j.errorCode ? `:${j.errorCode}` : ''}` : 'UNFINISHED';
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
const completed = e2e.length;
const lastDone = Math.max(...jobs.map((j) => j.doneAt ?? 0));
const avg = completed ? e2e.reduce((a, b) => a + b, 0) / completed : 0;

const report = {
  runId,
  at: new Date(started).toISOString(),
  config: { images: N, concurrency: C, users: U, noisy: args.noisy, fixtures: files.map((f) => f.name), totalMB: +(totalBytes / 1e6).toFixed(1) },
  replicasPeak: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, v.replicas])),
  outcome: byState,
  clientErrors: jobs.filter((j) => j.clientError).reduce<Record<string, number>>((acc, j) => ((acc[j.clientError!] = (acc[j.clientError!] ?? 0) + 1), acc), {}),
  networkRetries,
  throttled: { total: throttled, byCode: throttledByCode },
  latency: {
    endToEnd: { avg: Math.round(avg), p50: pct(e2e, 50), p95: pct(e2e, 95), p99: pct(e2e, 99), max: e2e.at(-1) ?? 0 },
    submit: { p50: pct(submitLat, 50), p95: pct(submitLat, 95) },
  },
  throughputPerSec: +(completed / ((lastDone - started) / 1000)).toFixed(2),
  totalDurationSec: +((finished - started) / 1000).toFixed(1),
  queuePeaks: peaks,
  stageLatencyP95Ms: Object.fromEntries((lastStats?.stages ?? []).map((x) => [x.stage, x.p95Ms])),
  ...(args.noisy
    ? (() => {
        const p95For = (pred: (j: Job) => boolean) =>
          pct(jobs.filter((j) => pred(j) && j.state === 'COMPLETED').map((j) => j.doneAt! - j.submittedAt!).sort((a, b) => a - b), 95);
        return { fairness: { noisyUserP95: p95For((j) => j.user === 0), otherUsersP95: p95For((j) => j.user !== 0) } };
      })()
    : {}),
};

console.log('\n══ load test report ══');
console.log(`outcome      ${Object.entries(byState).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`429s         ${throttled} ${JSON.stringify(throttledByCode)} · transport retries ${networkRetries}`);
const clientErrors = jobs.filter((j) => j.clientError).reduce<Record<string, number>>((acc, j) => ((acc[j.clientError!] = (acc[j.clientError!] ?? 0) + 1), acc), {});
if (Object.keys(clientErrors).length) console.log(`client errors ${JSON.stringify(clientErrors)}`);
console.log(`end-to-end   avg ${s(avg)} · p50 ${s(pct(e2e, 50))} · p95 ${s(pct(e2e, 95))} · p99 ${s(pct(e2e, 99))} · max ${s(e2e.at(-1) ?? 0)}`);
console.log(`submit       p50 ${s(pct(submitLat, 50))} · p95 ${s(pct(submitLat, 95))}  (create + S3 upload + complete)`);
console.log(`throughput   ${report.throughputPerSec} images/s · total ${report.totalDurationSec}s`);
console.log(`queue peaks  ${Object.entries(peaks).map(([k, v]) => `${k.toLowerCase()} depth ${v.queued} age ${s(v.oldestMs)} ×${v.replicas}`).join(' │ ')}`);
if (report.fairness) console.log(`fairness     noisy user p95 ${s(report.fairness.noisyUserP95)} vs others p95 ${s(report.fairness.otherUsersP95)}`);

await mkdir('loadtest-results', { recursive: true });
const out = path.join('loadtest-results', `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${runId}.json`);
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`saved        ${out}\n\n══ invariants ══`);

const ok = await runChecks(5);
await db().$disconnect();
process.exit(ok && !byState.UNFINISHED ? 0 : 1);
