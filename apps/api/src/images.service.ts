import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '@pipeline/core/config';
import { ERRORS, type ErrorCode } from '@pipeline/core/errors';
import { keys } from '@pipeline/core/keys';
import { Prisma, type Image, type Stage } from '@pipeline/core/models';
import { db } from '@pipeline/core/prisma';
import { enqueue, event } from '@pipeline/core/queue';
import { storage } from '@pipeline/core/s3';
import { SNIFF_BYTES, sniffFormat } from '@pipeline/core/sniff';
import { STAGES } from '@pipeline/core/stages';
import { admit } from './admission';
import { imageInclude, toDTO, type ImageDTO } from './dto';
import { HttpError, notFound } from './http';

// Browsers report HEIC inconsistently (often ''), so the declared type is only used for the upload
// policy. The real format is decided by magic bytes at /complete and again in CONVERT.
const DECLARED_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/octet-stream'] as const;

export const createImageSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'image'),
  mimeType: z
    .string()
    .transform((s) => s.toLowerCase() || 'application/octet-stream')
    .pipe(z.enum(DECLARED_TYPES)),
  sizeBytes: z.number().int().positive(),
});

export const idempotencyKeySchema = z.string().min(8).max(100).regex(/^[\w.:-]+$/).optional();

export const listSchema = z.object({
  ids: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.string().uuid()).max(100).optional()),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const reprocessSchema = z.object({
  force: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  from: z
    .string()
    .optional()
    .transform((v) => v?.toUpperCase())
    .pipe(z.enum(STAGES).optional()),
});

const owned = (userId: string, id: string) => ({ id, userId });

async function load(userId: string, id: string, withTimeline = false) {
  // Scoped by user: someone else's id is indistinguishable from a missing one (404, not 403).
  const image = await db().image.findFirst({
    where: owned(userId, id),
    include: { ...imageInclude, ...(withTimeline ? { events: { orderBy: { id: 'asc' as const }, take: 100 } } : {}) },
  });
  if (!image) throw notFound('Image not found');
  return image;
}

export async function getImage(userId: string, id: string): Promise<ImageDTO> {
  return toDTO(await load(userId, id, true));
}

export async function listImages(userId: string, q: z.infer<typeof listSchema>): Promise<{ items: ImageDTO[]; nextCursor: string | null }> {
  const images = await db().image.findMany({
    where: {
      userId,
      ...(q.ids ? { id: { in: q.ids } } : {}),
      ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
    },
    include: imageInclude,
    orderBy: { createdAt: 'desc' },
    take: q.ids ? q.ids.length : q.limit,
  });
  const items = await Promise.all(images.map(toDTO));
  const last = images.at(-1);
  return { items, nextCursor: !q.ids && last && images.length === q.limit ? last.createdAt.toISOString() : null };
}

/**
 * POST /images: admission control → row → presigned POST. With an Idempotency-Key, a retried submit
 * (network blip, double click) returns the same image instead of creating a second one.
 */
export async function createImage(userId: string, input: z.infer<typeof createImageSchema>, idempotencyKey?: string) {
  if (idempotencyKey) {
    const existing = await db().image.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, include: imageInclude });
    if (existing) return { created: false, image: await toDTO(existing), upload: await uploadFor(existing) };
  }

  if (input.sizeBytes > config.limits.maxBytes) throw new HttpError(422, 'FILE_TOO_LARGE', ERRORS.FILE_TOO_LARGE.message);
  if (input.sizeBytes < config.limits.minBytes) throw new HttpError(422, 'FILE_TOO_SMALL', ERRORS.FILE_TOO_SMALL.message);
  await admit(userId);

  const id = randomUUID();
  await db().$executeRaw`INSERT INTO users (id) VALUES (${userId}::uuid) ON CONFLICT DO NOTHING`;
  try {
    const image = await db().image.create({
      data: {
        id,
        userId,
        originalFilename: input.filename,
        declaredMime: input.mimeType,
        declaredBytes: input.sizeBytes,
        originalKey: keys.original(userId, id),
        idempotencyKey: idempotencyKey ?? null,
      },
      include: imageInclude,
    });
    return { created: true, image: await toDTO(image), upload: await uploadFor(image) };
  } catch (err) {
    // Two concurrent submits with the same key: the unique index picks one winner, the other reads it.
    if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await db().image.findUniqueOrThrow({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, include: imageInclude });
      return { created: false, image: await toDTO(winner), upload: await uploadFor(winner) };
    }
    throw err;
  }
}

function uploadFor(image: Image) {
  return image.status === 'UPLOADING' ? storage.presignUpload(image.originalKey, image.declaredMime) : Promise.resolve(null);
}

async function reject(image: Image, code: ErrorCode): Promise<never> {
  await db().$transaction(async (tx) => {
    const { count } = await tx.image.updateMany({
      where: { id: image.id, status: 'UPLOADING' },
      data: { status: 'REJECTED', errorCode: code, errorMessage: ERRORS[code].message, retryable: false },
    });
    if (count === 1) await event(tx, image.id, image.run, null, 'REJECTED', code);
  });
  throw new HttpError(422, code, ERRORS[code].message);
}

/**
 * POST /images/:id/complete: the light validation gate (exists, size, magic bytes from a 32-byte
 * ranged GET), then UPLOADING → PROCESSING + the CONVERT task in one transaction. Idempotent: a second
 * call returns the current state. Validation failures are synchronous 422s (REJECTED), which keeps
 * them distinct from pipeline failures (FAILED, with a stage). Part 1's content validator plugs in here.
 */
export async function completeUpload(userId: string, id: string): Promise<ImageDTO> {
  const image = await load(userId, id);
  if (image.status !== 'UPLOADING') return toDTO(image);

  const head = await storage.head(image.originalKey);
  if (!head) throw new HttpError(422, 'UPLOAD_MISSING', ERRORS.UPLOAD_MISSING.message); // state unchanged, client may retry
  if (head.sizeBytes > config.limits.maxBytes) await reject(image, 'FILE_TOO_LARGE');
  if (head.sizeBytes < config.limits.minBytes) await reject(image, 'FILE_TOO_SMALL');
  if (!sniffFormat(await storage.getRange(image.originalKey, SNIFF_BYTES))) await reject(image, 'UNSUPPORTED_FORMAT');

  await db().$transaction(async (tx) => {
    const { count } = await tx.image.updateMany({
      where: { id, status: 'UPLOADING' },
      data: { status: 'PROCESSING', stage: 'CONVERT', run: 1, originalBytes: head.sizeBytes },
    });
    if (count === 1) {
      await event(tx, id, 1, null, 'VALIDATED', `${head.sizeBytes} bytes`);
      await enqueue(tx, id, 1, 'CONVERT');
    }
  });
  return toDTO(await load(userId, id));
}

/** Where a reprocess resumes: the failed stage if its input still exists, otherwise from the start. */
async function resumeStage(image: Image, from: Stage | undefined): Promise<Stage> {
  const wanted: Stage =
    from ?? (image.status === 'FAILED' && image.errorStage && image.errorCode !== 'INTERMEDIATE_MISSING' ? image.errorStage : 'CONVERT');
  if (wanted === 'COMPRESS' && image.normalizedKey && (await storage.head(image.normalizedKey))) return 'COMPRESS';
  if (wanted === 'VARIANTS' && image.masterKey && (await storage.head(image.masterKey))) return 'VARIANTS';
  return 'CONVERT';
}

/**
 * POST /images/:id/reprocess. Policy:
 *  - only from a terminal pipeline state (FAILED, or COMPLETE with force=true): never races a running task
 *  - non-retryable failures (corrupt file) need force=true: retrying the same bytes can't succeed
 *  - resumes from the failed stage (convert isn't redone just because compress failed)
 *  - the run bump is conditional on the run we read, so two concurrent calls → one new run, the other
 *    just returns it (202 both times). The old run's in-flight writes, if any, are fenced out by `run`.
 */
export async function reprocess(userId: string, id: string, opts: z.infer<typeof reprocessSchema>): Promise<ImageDTO> {
  const image = await load(userId, id);
  if (image.status === 'PROCESSING') return toDTO(image);
  if (image.status === 'UPLOADING' || image.status === 'REJECTED') {
    throw new HttpError(409, 'NOT_REPROCESSABLE', 'This image never entered the pipeline. Upload it again.');
  }
  if (image.status === 'COMPLETE' && !opts.force) {
    throw new HttpError(409, 'ALREADY_COMPLETE', 'Image is already processed. Pass force=true to regenerate it.');
  }
  if (image.status === 'FAILED' && !image.retryable && !opts.force) {
    throw new HttpError(422, 'NOT_RETRYABLE', `${image.errorMessage ?? 'This failure'} Retrying will not help.`);
  }

  const stage = await resumeStage(image, opts.from);
  const run = image.run + 1;
  await db().$transaction(async (tx) => {
    const { count } = await tx.image.updateMany({
      where: { id, run: image.run, status: image.status },
      data: { run, status: 'PROCESSING', stage, errorStage: null, errorCode: null, errorMessage: null, retryable: null, completedAt: null },
    });
    if (count !== 1) return; // lost the race to a concurrent reprocess: return what it created
    await event(tx, id, run, stage, 'REPROCESS_REQUESTED', `from ${stage.toLowerCase()}${opts.force ? ' (forced)' : ''}`);
    await enqueue(tx, id, run, stage);
  });
  return toDTO(await load(userId, id));
}

/** Uploads the browser never completed: drop the row and the (maybe partial) object. */
export async function sweepAbandonedUploads(): Promise<number> {
  const abandoned = await db().image.findMany({
    where: { status: 'UPLOADING', createdAt: { lt: new Date(Date.now() - config.admission.abandonedUploadMs) } },
    select: { id: true, originalKey: true },
    take: 500,
  });
  if (abandoned.length === 0) return 0;
  await db().image.deleteMany({ where: { id: { in: abandoned.map((a) => a.id) }, status: 'UPLOADING' } });
  await storage.deleteMany(abandoned.map((a) => a.originalKey)).catch(() => {});
  return abandoned.length;
}
