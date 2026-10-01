/**
 * Local "deployment": run N replicas of each service as separate OS processes.
 *
 *   pnpm scale convert=2 compress=1 variants=4     # start a set
 *   pnpm scale variants=3                          # in another terminal: add 3 more variants replicas live
 *   Ctrl-C                                         # graceful drain of just this set
 *
 * Each replica is an independent process with its own DB pool and no shared memory, exactly what a
 * container would be. Scaling one stage never touches the others.
 * Options: CHAOS_FAIL_STAGE=compress (env) to inject failures, RAW_LOGS=1 for raw JSON logs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SERVICES = ['convert', 'compress', 'variants'] as const;
type Service = (typeof SERVICES)[number];
const COLORS: Record<Service, string> = { convert: '\x1b[36m', compress: '\x1b[33m', variants: '\x1b[35m' };

const plan = new Map<Service, number>();
for (const arg of process.argv.slice(2)) {
  const [name, count] = arg.split('=');
  if (!SERVICES.includes(name as Service) || !count || !/^\d+$/.test(count)) {
    console.error(`usage: pnpm scale convert=1 compress=1 variants=1   (got "${arg}")`);
    process.exit(1);
  }
  plan.set(name as Service, Number(count));
}
if (plan.size === 0) for (const s of SERVICES) plan.set(s, 1);

const short = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v.slice(0, 8) : v);

function format(label: string, color: string, line: string): string {
  if (process.env.RAW_LOGS) return `${color}${label}\x1b[0m ${line}`;
  try {
    const { t, event, workerId: _w, stage: _s, taskId: _t, ...rest } = JSON.parse(line) as Record<string, unknown>;
    const fields = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : short(v)}`)
      .join(' ');
    return `${String(t).slice(11, 19)} ${color}${label}\x1b[0m ${event} ${fields}`;
  } catch {
    return `${color}${label}\x1b[0m ${line}`;
  }
}

const children: ChildProcess[] = [];
for (const [service, count] of plan) {
  for (let i = 1; i <= count; i++) {
    const label = `${service}#${i}`.padEnd(11);
    const child = spawn(process.execPath, ['--import', 'tsx', `services/${service}/src/index.ts`], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pipe = (stream: NodeJS.ReadableStream) => {
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) console.log(format(label, COLORS[service], line));
        }
      });
    };
    pipe(child.stdout!);
    pipe(child.stderr!);
    child.on('exit', (code, signal) => console.log(`${COLORS[service]}${label}\x1b[0m exited (${signal ?? code})`));
    children.push(child);
  }
}
console.log(`started ${children.length} replica(s): ${[...plan].map(([s, n]) => `${s}=${n}`).join(' ')} — Ctrl-C drains gracefully`);

let stopping = false;
function stop(signal: NodeJS.Signals) {
  if (stopping) {
    // Second Ctrl-C: hard kill (simulates a crash; leases will expire and other replicas reclaim).
    for (const c of children) c.kill('SIGKILL');
    process.exit(1);
  }
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill(signal);
}
process.on('SIGINT', () => stop('SIGTERM'));
process.on('SIGTERM', () => stop('SIGTERM'));

await Promise.all(children.map((c) => new Promise((resolve) => c.on('exit', resolve))));
process.exit(0);
