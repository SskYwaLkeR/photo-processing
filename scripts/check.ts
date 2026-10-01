/**
 * Invariant checker: proves (not just claims) that the system state is consistent. Run after a load
 * test, a chaos run, or a crash demo. Exit code 1 if anything is violated.
 *
 *   pnpm check              # DB invariants
 *   pnpm check --sample 10  # + S3: exactly 3 objects per sampled image, and no EXIF/GPS in variants
 */
import sharp from 'sharp';
import { config } from '@pipeline/core/config';
import { db } from '@pipeline/core/prisma';
import { storage } from '@pipeline/core/s3';

interface Check {
  name: string;
  sql: string;
}

const LEASE_SECONDS = Math.ceil((config.worker.leaseMs * 2) / 1000);

const CHECKS: Check[] = [
  {
    name: 'COMPLETE ⇒ exactly 3 variants from the current run',
    sql: `SELECT i.id FROM images i LEFT JOIN variants v ON v.image_id = i.id AND v.run = i.run
          WHERE i.status = 'COMPLETE' GROUP BY i.id HAVING count(v.*) <> 3`,
  },
  {
    name: 'COMPLETE ⇒ the current run finished VARIANTS',
    sql: `SELECT i.id FROM images i WHERE i.status = 'COMPLETE' AND NOT EXISTS (
            SELECT 1 FROM tasks t WHERE t.image_id = i.id AND t.run = i.run AND t.stage = 'VARIANTS' AND t.status = 'DONE')`,
  },
  { name: 'no image has more than 3 variant rows', sql: `SELECT image_id FROM variants GROUP BY image_id HAVING count(*) > 3` },
  {
    name: 'FAILED / REJECTED ⇒ has a code and message (FAILED also a stage)',
    sql: `SELECT id FROM images WHERE (status IN ('FAILED', 'REJECTED') AND (error_code IS NULL OR error_message IS NULL))
            OR (status = 'FAILED' AND error_stage IS NULL)`,
  },
  {
    name: 'PROCESSING ⇒ exactly one active task, for the current run and stage',
    sql: `SELECT i.id FROM images i LEFT JOIN tasks t ON t.image_id = i.id AND t.status IN ('QUEUED', 'RUNNING')
          WHERE i.status = 'PROCESSING'
          GROUP BY i.id, i.run, i.stage HAVING count(t.*) <> 1 OR bool_or(t.run <> i.run OR t.stage <> i.stage)`,
  },
  {
    name: 'terminal images have no active task',
    sql: `SELECT t.id FROM tasks t JOIN images i ON i.id = t.image_id
          WHERE t.status IN ('QUEUED', 'RUNNING') AND i.status <> 'PROCESSING'`,
  },
  { name: 'no duplicate (image, run, stage) task', sql: `SELECT image_id FROM tasks GROUP BY image_id, run, stage HAVING count(*) > 1` },
  {
    name: `no RUNNING task with a lease older than ${LEASE_SECONDS}s (stuck)`,
    sql: `SELECT id FROM tasks WHERE status = 'RUNNING' AND locked_at < now() - interval '${LEASE_SECONDS} seconds'`,
  },
];

export async function runChecks(sample = 0): Promise<boolean> {
  const prisma = db();
  let ok = true;
  for (const check of CHECKS) {
    const rows = await prisma.$queryRawUnsafe<{ id?: string; image_id?: string }[]>(check.sql);
    const pass = rows.length === 0;
    ok &&= pass;
    const ids = rows.slice(0, 3).map((r) => String(r.id ?? r.image_id).slice(0, 8));
    console.log(`${pass ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${check.name}${pass ? '' : `  (${rows.length}: ${ids.join(', ')}…)`}`);
  }

  if (sample > 0) {
    const images = await prisma.image.findMany({
      where: { status: 'COMPLETE' },
      orderBy: { completedAt: 'desc' },
      take: sample,
      select: { id: true, userId: true, variants: { select: { key: true } } },
    });
    let objectsOk = true;
    let exifOk = true;
    for (const img of images) {
      const objects = await storage.list(`variants/${img.userId}/${img.id}/`);
      if (objects.length !== 3) objectsOk = false;
      for (const v of img.variants) {
        const meta = await sharp(await storage.getBuffer(v.key)).metadata();
        if (meta.exif || meta.xmp || meta.iptc) exifOk = false;
      }
    }
    ok &&= objectsOk && exifOk;
    console.log(`${objectsOk ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} S3: exactly 3 variant objects per image (${images.length} sampled)`);
    console.log(`${exifOk ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} S3: no EXIF/XMP/IPTC (GPS) metadata in served variants`);
  }

  const counts = await prisma.$queryRaw<{ status: string; n: number }[]>`
    SELECT status::text AS status, count(*)::int AS n FROM images GROUP BY status ORDER BY status`;
  console.log(`images: ${counts.map((c) => `${c.status}=${c.n}`).join(' ') || 'none'}`);
  return ok;
}

if (process.argv[1]?.endsWith("check.ts")) {
  const i = process.argv.indexOf('--sample');
  const sample = i >= 0 ? Number(process.argv[i + 1] ?? 5) : 0;
  const ok = await runChecks(sample);
  await db().$disconnect();
  process.exit(ok ? 0 : 1);
}
