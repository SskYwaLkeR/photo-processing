import type { Image, ImageEvent, Prisma, Task, Variant } from '@pipeline/core/models';
import { storage } from '@pipeline/core/s3';
import { derivedState } from '@pipeline/core/stages';

export interface VariantDTO {
  name: 'thumb' | 'web' | 'full';
  url: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  run: number;
  /** false while a reprocess is running: these are the previous run's variants, still served. */
  current: boolean;
}

export interface ImageDTO {
  id: string;
  filename: string;
  status: Image['status'];
  /** Fine-grained: QUEUED_CONVERSION, CONVERTING, …, COMPLETED, FAILED, REJECTED. */
  state: string;
  stage: Image['stage'];
  run: number;
  attempt: number | null;
  original: { format: string | null; bytes: number | null; width: number | null; height: number | null };
  compression: { originalBytes: number; compressedBytes: number; ratio: number; savedPercent: number; quality: number | null } | null;
  error: { stage: Image['errorStage']; code: string; message: string; retryable: boolean } | null;
  variants: VariantDTO[];
  canReprocess: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  timeline?: { at: string; run: number; stage: string | null; type: string; detail: string | null }[];
}

export type ImageWithRelations = Image & {
  tasks: Pick<Task, 'status' | 'attempts'>[];
  variants: Variant[];
  events?: ImageEvent[];
};

/** Projection shared by every read: the active task (≤1 by DB constraint) and the variants. */
export const imageInclude = {
  tasks: { where: { status: { in: ['QUEUED', 'RUNNING'] } }, select: { status: true, attempts: true }, take: 1 },
  variants: true,
} satisfies Prisma.ImageInclude;

const VARIANT_ORDER = { THUMB: 0, WEB: 1, FULL: 2 } as const;

export async function toDTO(image: ImageWithRelations): Promise<ImageDTO> {
  const active = image.tasks[0] ?? null;
  const variants = await Promise.all(
    [...image.variants]
      .sort((a, b) => VARIANT_ORDER[a.name] - VARIANT_ORDER[b.name])
      .map(async (v) => ({
        name: v.name.toLowerCase() as VariantDTO['name'],
        url: await storage.presignGet(v.key),
        format: v.format,
        width: v.width,
        height: v.height,
        bytes: v.bytes,
        run: v.run,
        current: v.run === image.run,
      })),
  );
  const compression =
    image.compressedBytes && image.originalBytes
      ? {
          originalBytes: image.originalBytes,
          compressedBytes: image.compressedBytes,
          ratio: image.compressionRatio ?? image.compressedBytes / image.originalBytes,
          savedPercent: Math.round((1 - image.compressedBytes / image.originalBytes) * 1000) / 10,
          quality: image.compressionQuality,
        }
      : null;

  return {
    id: image.id,
    filename: image.originalFilename,
    status: image.status,
    state: derivedState(image.status, image.stage, active),
    stage: image.stage,
    run: image.run,
    attempt: active?.attempts ?? null,
    original: { format: image.originalFormat, bytes: image.originalBytes ?? image.declaredBytes, width: image.width, height: image.height },
    compression,
    error:
      image.errorCode && image.errorMessage
        ? { stage: image.errorStage, code: image.errorCode, message: image.errorMessage, retryable: image.retryable ?? false }
        : null,
    variants,
    canReprocess: image.status === 'FAILED' && (image.retryable ?? false),
    createdAt: image.createdAt.toISOString(),
    updatedAt: image.updatedAt.toISOString(),
    completedAt: image.completedAt?.toISOString() ?? null,
    timeline: image.events?.map((e) => ({ at: e.at.toISOString(), run: e.run, stage: e.stage, type: e.type, detail: e.detail })),
  };
}
