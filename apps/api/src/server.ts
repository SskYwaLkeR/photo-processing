import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { config } from '@pipeline/core/config';
import { log } from '@pipeline/core/log';
import { db } from '@pipeline/core/prisma';
import { errorHandler, notFoundHandler } from './http';
import { identity } from './identity';
import { sweepAbandonedUploads } from './images.service';
import { rateLimit } from './rateLimit';
import { buildRouter } from './routes';

const app = express();
app.disable('x-powered-by');
app.set('etag', 'weak');

// JSON-only API: nothing here should ever render, frame, or be embedded.
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.isProduction,
  }),
);
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); // default; status reads override with no-cache for ETags
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
app.use('/api', identity);

const readLimiter = rateLimit({ windowMs: 60_000, max: 1200 });
const writeLimiter = rateLimit({ windowMs: 60_000, max: 600 });
app.use('/api', (req, res, next) => (req.method === 'GET' ? readLimiter : writeLimiter)(req, res, next));

app.use(buildRouter());
app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => log('api.listening', { url: `http://localhost:${config.port}` }));

const maintenance = setInterval(() => {
  sweepAbandonedUploads()
    .then((n) => n > 0 && log('api.swept_abandoned_uploads', { count: n }))
    .catch((err) => log('api.sweep_failed', { error: String(err) }));
}, 5 * 60_000);

async function shutdown() {
  clearInterval(maintenance);
  server.close();
  await db().$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
