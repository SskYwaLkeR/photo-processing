import type { VariantName } from '@prisma/client';

/**
 * Stage-first prefixes so S3 lifecycle rules (expire work/ after 7 days) and per-service IAM policies
 * can target each stage by prefix. Keys are deterministic: a retry or reprocess overwrites, never adds.
 * Only server-generated UUIDs appear in keys — never filenames or other user input.
 */
export const keys = {
  original: (userId: string, imageId: string) => `originals/${userId}/${imageId}`,
  normalized: (userId: string, imageId: string) => `work/${userId}/${imageId}/normalized.jpg`,
  master: (userId: string, imageId: string) => `work/${userId}/${imageId}/master.jpg`,
  variant: (userId: string, imageId: string, name: VariantName) => `variants/${userId}/${imageId}/${name.toLowerCase()}.jpg`,
};
