import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '@pipeline/core/config';

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

const COOKIE = 'uid';
const uuid = z.string().uuid();

/**
 * Anonymous identity: an httpOnly cookie holding a random UUID. Auth is out of scope; every query is
 * already scoped by req.userId, so real auth only has to replace this middleware. No DB hit here:
 * the users row is created lazily on first upload (connectOrCreate).
 */
export const identity: RequestHandler = (req, res, next) => {
  const existing = uuid.safeParse(req.cookies?.[COOKIE]);
  if (existing.success) {
    req.userId = existing.data;
  } else {
    req.userId = randomUUID();
    res.cookie(COOKIE, req.userId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }
  next();
};
