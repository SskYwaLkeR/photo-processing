import sharp from 'sharp';
import { config } from './config';

/**
 * Per-process libvips settings for long-running workers:
 *  - cache off: it only helps repeated ops on the same file and otherwise just holds memory.
 *  - threads per op capped: replicas × concurrency × threads should roughly match the cores.
 */
export function configureSharp(): void {
  sharp.cache(false);
  sharp.concurrency(Number(process.env.SHARP_THREADS ?? 2));
}

/** Every decode goes through this: pixel limit (decompression bombs) and fail on truncated input. */
export function decode(input: Buffer) {
  return sharp(input, { limitInputPixels: config.limits.maxInputPixels, failOn: 'error' });
}
