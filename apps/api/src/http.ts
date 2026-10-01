import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Throw from any handler or service; the error middleware turns it into `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
    return;
  }
  if (typeof err?.status === 'number' && err.status < 500) {
    res.status(err.status).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request' } });
    return;
  }
  console.log('[api] unhandled error', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
