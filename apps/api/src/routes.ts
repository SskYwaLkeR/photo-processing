import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '@pipeline/core/config';
import { HttpError, notFound } from './http';
import {
  completeUpload,
  createImage,
  createImageSchema,
  getImage,
  idempotencyKeySchema,
  listImages,
  listSchema,
  reprocess,
  reprocessSchema,
} from './images.service';
import { rateLimit } from './rateLimit';
import { pipelineStats } from './stats.service';

const uuid = z.string().uuid();
/** A malformed id is indistinguishable from a missing one: 404. */
function imageId(req: Request): string {
  const parsed = uuid.safeParse(req.params.id);
  if (!parsed.success) throw notFound('Image not found');
  return parsed.data;
}

/** Status reads are polled: let clients revalidate with If-None-Match and get a 304. */
const revalidate: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-cache');
  next();
};

/** Operator endpoints. Disabled entirely (404) when ADMIN_TOKEN is not configured. */
const adminOnly: RequestHandler = (req, _res, next) => {
  const expected = Buffer.from(config.adminToken);
  const given = Buffer.from(String(req.header('x-admin-token') ?? ''));
  if (!config.adminToken) return next(notFound());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return next(new HttpError(401, 'UNAUTHORIZED', 'Admin token required'));
  next();
};

export function buildRouter(): Router {
  const r = Router();
  const reprocessLimiter = rateLimit({ windowMs: 60_000, max: 30 });

  r.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  r.post('/api/images', async (req, res) => {
    const body = createImageSchema.parse(req.body);
    const key = idempotencyKeySchema.parse(req.header('idempotency-key') ?? undefined);
    const { created, image, upload } = await createImage(req.userId, body, key);
    res.status(created ? 201 : 200).json({ image, upload });
  });

  r.get('/api/images', revalidate, async (req, res) => {
    res.json(await listImages(req.userId, listSchema.parse(req.query)));
  });

  r.get('/api/images/:id', revalidate, async (req, res) => {
    res.json({ image: await getImage(req.userId, imageId(req)) });
  });

  r.post('/api/images/:id/complete', async (req, res) => {
    res.status(202).json({ image: await completeUpload(req.userId, imageId(req)) });
  });

  r.post('/api/images/:id/reprocess', reprocessLimiter, async (req, res) => {
    res.status(202).json({ image: await reprocess(req.userId, imageId(req), reprocessSchema.parse(req.query)) });
  });

  r.get('/api/admin/stats', adminOnly, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await pipelineStats());
  });

  return r;
}
