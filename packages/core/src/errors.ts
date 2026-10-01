/**
 * The only error text users ever see. Raw errors (stack traces, AWS messages) go to tasks.last_error
 * and the logs, never to the API.
 */
export const ERRORS = {
  // Validation at /complete → image REJECTED, never enters the pipeline
  UPLOAD_MISSING: { message: 'The upload never reached storage. Please upload the file again.', retryable: false },
  FILE_TOO_SMALL: { message: 'The file is too small to be a real photo.', retryable: false },
  FILE_TOO_LARGE: { message: 'The file is larger than the 50 MB limit.', retryable: false },
  UNSUPPORTED_FORMAT: { message: 'This file is not a JPEG, PNG or HEIC image.', retryable: false },

  // Permanent pipeline failures → image FAILED immediately, no retries
  CORRUPT: { message: "The image is damaged or incomplete and can't be decoded.", retryable: false },
  TOO_MANY_PIXELS: { message: 'The image dimensions are too large to process (max 100 megapixels).', retryable: false },
  SOURCE_MISSING: { message: 'The original upload is no longer available.', retryable: false },
  /** A stage's input (work/ intermediate) is gone, e.g. expired by lifecycle. Reprocess restarts from CONVERT. */
  INTERMEDIATE_MISSING: { message: 'An intermediate file expired. Reprocessing will start from the beginning.', retryable: true },

  // Transient failures that exhausted their retry budget → FAILED, user can reprocess
  PROCESSING_FAILED: { message: "We couldn't process this image after several attempts. You can try again.", retryable: true },
  TIMED_OUT: { message: 'Processing took too long and was stopped. You can try again.', retryable: true },
} as const satisfies Record<string, { message: string; retryable: boolean }>;

export type ErrorCode = keyof typeof ERRORS;

/** Input problem: retrying the same bytes can never succeed. */
export class PermanentError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** The worker lost its lease (another replica reclaimed the task); its result must be discarded. */
export class LeaseLostError extends Error {}

export class TaskTimeoutError extends Error {}

/**
 * Classified by where the error came from, not by matching message text: handlers wrap decode of
 * *user input* in PermanentError explicitly. Everything else (S3, Postgres, timeouts, our own bugs)
 * is treated as transient and retried with backoff up to the attempt budget.
 */
export function classify(err: unknown): { kind: 'permanent'; code: ErrorCode } | { kind: 'transient' } {
  if (err instanceof PermanentError) return { kind: 'permanent', code: err.code };
  return { kind: 'transient' };
}

export function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 1000);
}
