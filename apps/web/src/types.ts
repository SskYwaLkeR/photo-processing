// Mirrors apps/api/src/dto.ts (the API is the source of truth for these shapes).
export type Stage = 'CONVERT' | 'COMPRESS' | 'VARIANTS';

export interface Variant {
  name: 'thumb' | 'web' | 'full';
  url: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  run: number;
  current: boolean;
}

export interface Image {
  id: string;
  filename: string;
  status: 'UPLOADING' | 'PROCESSING' | 'COMPLETE' | 'FAILED' | 'REJECTED';
  state: string;
  stage: Stage | null;
  run: number;
  attempt: number | null;
  original: { format: string | null; bytes: number | null; width: number | null; height: number | null };
  compression: { originalBytes: number; compressedBytes: number; ratio: number; savedPercent: number; quality: number | null } | null;
  error: { stage: Stage | null; code: string; message: string; retryable: boolean } | null;
  variants: Variant[];
  canReprocess: boolean;
  createdAt: string;
  completedAt: string | null;
  timeline?: { at: string; run: number; stage: Stage | null; type: string; detail: string | null }[];
}

export interface StageStats {
  stage: Stage;
  queued: number;
  retrying: number;
  running: number;
  oldestQueuedMs: number;
  doneLastMinute: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  failed: number;
  replicas: number;
  slots: number;
  workers: { id: string; pid: number; inFlight: number; concurrency: number; draining: boolean }[];
}

export interface Stats {
  at: string;
  stages: StageStats[];
  images: Record<string, number>;
  admission: { inFlight: number; globalMaxInFlight: number; userMaxInFlight: number; rejectedLastMinute: number; rejectedByCode: Record<string, number> };
}

export const TERMINAL = new Set(['COMPLETE', 'FAILED', 'REJECTED']);
