import sharp from 'sharp';
import { PermanentError } from '@pipeline/core/errors';
import { decode } from '@pipeline/core/imaging';
import { keys } from '@pipeline/core/keys';
import type { VariantOutput } from '@pipeline/core/queue';
import { isNotFound, storage } from '@pipeline/core/s3';
import type { Handler } from '@pipeline/core/worker';

export const SIZES = {
  THUMB: { size: 320, fit: 'cover' as const }, // square crop, attention-based so the face stays in frame
  WEB: { size: 1600, fit: 'inside' as const },
};

/**
 * VARIANTS: master → thumb (320² crop), web (≤1600px), full (the master itself, copied server-side,
 * so no third encode and no generation loss). The DB rows are written all-or-nothing by the queue's
 * completion transaction: a crash halfway leaves no partial set, and the retry overwrites the same keys.
 */
export const variants: Handler = async (task) => {
  if (!task.masterKey) throw new PermanentError('INTERMEDIATE_MISSING', 'no master recorded');
  let master: Buffer;
  try {
    master = await storage.getBuffer(task.masterKey);
  } catch (err) {
    if (isNotFound(err)) throw new PermanentError('INTERMEDIATE_MISSING', task.masterKey);
    throw err;
  }

  const base = decode(master);
  const meta = await base.metadata();
  const out: VariantOutput[] = [];

  // Sequential on purpose: one decoded image in memory per task, concurrency is the replica's job.
  for (const name of ['THUMB', 'WEB'] as const) {
    const { size, fit } = SIZES[name];
    const { data, info } = await base
      .clone()
      .resize(size, size, { fit, position: fit === 'cover' ? sharp.strategy.attention : undefined, withoutEnlargement: fit === 'inside' })
      .jpeg({ quality: name === 'THUMB' ? 76 : 80, mozjpeg: true, progressive: name === 'WEB' })
      .toBuffer({ resolveWithObject: true });
    const key = keys.variant(task.userId, task.imageId, name);
    await storage.put(key, data, 'image/jpeg');
    out.push({ name, key, format: 'jpeg', width: info.width, height: info.height, bytes: data.length });
  }

  const fullKey = keys.variant(task.userId, task.imageId, 'FULL');
  await storage.copy(task.masterKey, fullKey, 'image/jpeg');
  out.push({ name: 'FULL', key: fullKey, format: 'jpeg', width: meta.width ?? 0, height: meta.height ?? 0, bytes: master.length });

  return { stage: 'VARIANTS', variants: out };
};
