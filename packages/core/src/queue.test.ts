/**
 * Concurrency and failure semantics of the queue, against the real local Postgres (these are the
 * properties that can't be unit-tested with mocks). Each test uses its own user and cleans up.
 * Skipped when the schema isn't migrated.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Stage } from '@prisma/client';
import { config } from './config';
import { db } from './prisma';
import { claim, complete, enqueue, failPermanent, failTransient, sweep, type ClaimedTask, type StageResult } from './queue';

const prisma = db();
const userId = randomUUID();
let migrated = true;

before(async () => {
  try {
    await prisma.$executeRaw`INSERT INTO users (id) VALUES (${userId}::uuid)`;
  } catch {
    migrated = false;
  }
});
after(async () => {
  if (migrated) await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

/** A PROCESSING image with one QUEUED task for `stage`. */
async function seed(stage: Stage = 'CONVERT') {
  const id = randomUUID();
  await prisma.image.create({
    data: {
      id,
      userId,
      status: 'PROCESSING',
      stage,
      run: 1,
      originalFilename: 't.jpg',
      declaredMime: 'image/jpeg',
      declaredBytes: 1000,
      originalKey: `originals/${userId}/${id}`,
      originalBytes: 1000,
      normalizedKey: 'n',
      masterKey: 'm',
    },
  });
  await enqueue(prisma, id, 1, stage);
  return id;
}

/** Claims only this test's task: the dev DB may hold other work, so filter to our image. */
async function claimMine(imageId: string, stage: Stage, worker: string): Promise<ClaimedTask | undefined> {
  for (let i = 0; i < 20; i++) {
    const got = await claim(prisma, stage, 50, worker);
    const mine = got.find((t) => t.imageId === imageId);
    // Put back anything that isn't ours untouched.
    const others = got.filter((t) => t.imageId !== imageId).map((t) => t.id);
    if (others.length) {
      await prisma.$executeRaw`UPDATE tasks SET status = 'QUEUED', locked_by = NULL, locked_at = NULL, attempts = attempts - 1 WHERE id = ANY(${others}::uuid[])`;
    }
    if (mine || got.length === 0) return mine;
  }
  return undefined;
}

const expireLease = (taskId: string) => prisma.$executeRaw`UPDATE tasks SET locked_at = now() - interval '1 hour' WHERE id = ${taskId}::uuid`;

const convertResult: StageResult = {
  stage: 'CONVERT',
  originalFormat: 'jpeg',
  originalBytes: 1000,
  width: 10,
  height: 10,
  normalizedKey: 'n',
  normalizedBytes: 900,
};

const variantsResult: StageResult = {
  stage: 'VARIANTS',
  variants: (['THUMB', 'WEB', 'FULL'] as const).map((name) => ({ name, key: `k/${name}`, format: 'jpeg', width: 1, height: 1, bytes: 1 })),
};

describe('queue', { skip: !process.env.DATABASE_URL && 'DATABASE_URL not set' }, () => {
  test('two workers claiming at the same time never get the same task', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed();
    const [a, b] = await Promise.all([claimMine(imageId, 'CONVERT', 'A'), claimMine(imageId, 'CONVERT', 'B')]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  test('a duplicate enqueue is a no-op (unique (image, run, stage) + one active task)', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed();
    assert.equal(await enqueue(prisma, imageId, 1, 'CONVERT'), false);
    assert.equal(await enqueue(prisma, imageId, 1, 'COMPRESS'), false, 'second active task for the same image');
    assert.equal(await prisma.task.count({ where: { imageId } }), 1);
  });

  test('crash recovery: an expired lease is reclaimed, and the zombie worker is fenced out', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed();
    const a = await claimMine(imageId, 'CONVERT', 'A');
    assert.ok(a);
    await expireLease(a.id); // A "crashed" (or stalled past its lease)
    const b = await claimMine(imageId, 'CONVERT', 'B');
    assert.ok(b);
    assert.equal(b.attempts, 2);

    assert.equal(await complete(prisma, a, 'A', convertResult, 5), 'FENCED', 'zombie A must not write');
    assert.equal(await complete(prisma, b, 'B', convertResult, 5), 'DONE');
    assert.equal(await complete(prisma, b, 'B', convertResult, 5), 'FENCED', 'redelivered completion must not double-enqueue');

    const tasks = await prisma.task.findMany({ where: { imageId }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(
      tasks.map((x) => [x.stage, x.status]),
      [
        ['CONVERT', 'DONE'],
        ['COMPRESS', 'QUEUED'],
      ],
    );
    const image = await prisma.image.findUniqueOrThrow({ where: { id: imageId } });
    assert.equal(image.stage, 'COMPRESS');
  });

  test('VARIANTS completion writes exactly 3 rows and COMPLETE; reprocessing upserts, never duplicates', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed('VARIANTS');
    const a = await claimMine(imageId, 'VARIANTS', 'A');
    assert.ok(a);
    assert.equal(await complete(prisma, a, 'A', variantsResult, 5), 'DONE');

    // Simulate a forced reprocess of the final stage (run 2) and complete it again.
    await prisma.image.update({ where: { id: imageId }, data: { run: 2, status: 'PROCESSING' } });
    await enqueue(prisma, imageId, 2, 'VARIANTS');
    const b = await claimMine(imageId, 'VARIANTS', 'B');
    assert.ok(b);
    assert.equal(await complete(prisma, b, 'B', variantsResult, 5), 'DONE');

    const variants = await prisma.variant.findMany({ where: { imageId } });
    assert.equal(variants.length, 3);
    assert.ok(variants.every((v) => v.run === 2));
    assert.equal((await prisma.image.findUniqueOrThrow({ where: { id: imageId } })).status, 'COMPLETE');
  });

  test('permanent failure stops the job with stage + reason and enqueues nothing', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed();
    const a = await claimMine(imageId, 'CONVERT', 'A');
    assert.ok(a);
    await failPermanent(prisma, a, 'A', 'CORRUPT', 'VipsJpeg: premature end', 5);
    const image = await prisma.image.findUniqueOrThrow({ where: { id: imageId } });
    assert.deepEqual([image.status, image.errorStage, image.errorCode, image.retryable], ['FAILED', 'CONVERT', 'CORRUPT', false]);
    assert.equal(await prisma.task.count({ where: { imageId, status: { in: ['QUEUED', 'RUNNING'] } } }), 0);
  });

  test('transient failure retries with backoff, then fails retryable after the attempt budget', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed();
    for (let attempt = 1; attempt <= config.worker.maxAttempts; attempt++) {
      await prisma.$executeRaw`UPDATE tasks SET available_at = now() WHERE image_id = ${imageId}::uuid`; // skip the backoff wait
      const task = await claimMine(imageId, 'CONVERT', 'A');
      assert.ok(task, `attempt ${attempt} claimable`);
      assert.equal(task.attempts, attempt);
      await failTransient(prisma, task, 'A', 'PROCESSING_FAILED', 'S3 timeout', 5);
    }
    const image = await prisma.image.findUniqueOrThrow({ where: { id: imageId } });
    assert.deepEqual([image.status, image.errorCode, image.retryable], ['FAILED', 'PROCESSING_FAILED', true]);
  });

  test('a lease that expires on the final attempt is swept to TIMED_OUT (nothing stays PROCESSING forever)', async (t) => {
    if (!migrated) return t.skip('schema not migrated');
    const imageId = await seed();
    await prisma.$executeRaw`UPDATE tasks SET attempts = ${config.worker.maxAttempts - 1}::int WHERE image_id = ${imageId}::uuid`;
    const a = await claimMine(imageId, 'CONVERT', 'A');
    assert.ok(a);
    await expireLease(a.id);
    assert.equal(await claimMine(imageId, 'CONVERT', 'B'), undefined, 'no attempts left to reclaim');
    await sweep(prisma, 'CONVERT');
    const image = await prisma.image.findUniqueOrThrow({ where: { id: imageId } });
    assert.deepEqual([image.status, image.errorCode, image.retryable], ['FAILED', 'TIMED_OUT', true]);
  });
});
