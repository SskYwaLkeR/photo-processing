import heicConvert from 'heic-convert';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { config } from '@pipeline/core/config';
import { PermanentError } from '@pipeline/core/errors';
import { decode } from '@pipeline/core/imaging';
import { keys } from '@pipeline/core/keys';
import type { Handler } from '@pipeline/core/worker';
import { isNotFound, storage } from '@pipeline/core/s3';
import { sniffFormat } from '@pipeline/core/sniff';

/**
 * CONVERT: original (JPEG / PNG / HEIC) → normalized JPEG: EXIF orientation applied, sRGB, alpha
 * flattened, metadata (EXIF/GPS) stripped, q95 4:4:4 so the later stages start from a near-lossless copy.
 *
 * Every failure while reading the *user's bytes* is permanent: retrying can't fix a corrupt file.
 * S3/network errors are left to bubble up as transient.
 */
export const convert: Handler = async (task) => {
  let raw: Buffer;
  try {
    raw = await storage.getBuffer(task.originalKey);
  } catch (err) {
    if (isNotFound(err)) throw new PermanentError('SOURCE_MISSING');
    throw err;
  }

  const format = sniffFormat(raw);
  if (!format) throw new PermanentError('UNSUPPORTED_FORMAT', 'magic bytes do not match JPEG, PNG or HEIC');

  // Pixel-bomb guard BEFORE decoding anything. sharp reads dimensions from the header — for HEIC too,
  // from the HEIF container, even though its libheif can't decode HEVC (verified in a spike). This
  // matters because heic-convert decodes the whole image in wasm with no pixel limit of its own.
  let meta: Metadata;
  try {
    meta = await sharp(raw).metadata();
  } catch (err) {
    throw new PermanentError('CORRUPT', (err as Error).message);
  }
  if (!meta.width || !meta.height) throw new PermanentError('CORRUPT', 'missing dimensions');
  if (meta.width * meta.height > config.limits.maxInputPixels) {
    throw new PermanentError('TOO_MANY_PIXELS', `${meta.width}x${meta.height}`);
  }

  let input = raw;
  if (format === 'heic') {
    // The prebuilt sharp has no HEVC decoder (patent licensing); heic-convert is libheif in wasm.
    try {
      input = Buffer.from(await heicConvert({ buffer: raw, format: 'JPEG', quality: 0.95 }));
    } catch (err) {
      throw new PermanentError('CORRUPT', `HEIC decode failed: ${(err as Error).message}`);
    }
  }

  let normalized: { data: Buffer; info: OutputInfo };
  try {
    normalized = await decode(input)
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new PermanentError('CORRUPT', (err as Error).message);
  }

  const normalizedKey = keys.normalized(task.userId, task.imageId);
  await storage.put(normalizedKey, normalized.data, 'image/jpeg');

  return {
    stage: 'CONVERT',
    originalFormat: format,
    originalBytes: raw.length,
    width: normalized.info.width,
    height: normalized.info.height,
    normalizedKey,
    normalizedBytes: normalized.data.length,
  };
};
