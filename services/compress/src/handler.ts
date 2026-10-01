import { PermanentError } from '@pipeline/core/errors';
import { decode } from '@pipeline/core/imaging';
import { keys } from '@pipeline/core/keys';
import { isNotFound, storage } from '@pipeline/core/s3';
import type { Handler } from '@pipeline/core/worker';

/** mozjpeg q80 is visually transparent for photos at typical viewing sizes. Adaptive (SSIM-targeted)
 *  quality is the upgrade, see ROADMAP. */
export const QUALITY = 80;

/**
 * COMPRESS: normalized → master JPEG at full resolution (mozjpeg, progressive, trellis quantisation).
 * The ratio is measured against what the user uploaded. Input here is our own JPEG, so a decode
 * failure is a bug, not bad input: it is left transient (retried, then PROCESSING_FAILED).
 */
export const compress: Handler = async (task) => {
  if (!task.normalizedKey || !task.originalBytes) throw new PermanentError('INTERMEDIATE_MISSING', 'no normalized output recorded');
  let input: Buffer;
  try {
    input = await storage.getBuffer(task.normalizedKey);
  } catch (err) {
    if (isNotFound(err)) throw new PermanentError('INTERMEDIATE_MISSING', task.normalizedKey);
    throw err;
  }

  const master = await decode(input).jpeg({ quality: QUALITY, mozjpeg: true, progressive: true }).toBuffer();
  const masterKey = keys.master(task.userId, task.imageId);
  await storage.put(masterKey, master, 'image/jpeg');

  return {
    stage: 'COMPRESS',
    masterKey,
    compressedBytes: master.length,
    compressionRatio: Math.round((master.length / task.originalBytes) * 10_000) / 10_000,
    quality: QUALITY,
  };
};
