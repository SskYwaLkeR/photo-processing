import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const ENV_DIR = '../..';
// Read in Node only; nothing here is exposed to client code (no VITE_ prefix).
const env = loadEnv('', ENV_DIR, '');
const s3Origin = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`;

/** The only third-party origin is our bucket: uploads go to it, presigned variants load from it. */
function securityHeaders(dev: boolean): Record<string, string> {
  const csp = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...(dev ? ["'unsafe-inline'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'blob:', 'data:', s3Origin],
    'connect-src': ["'self'", s3Origin, ...(dev ? ['ws:'] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return {
    'Content-Security-Policy': Object.entries(csp).map(([k, v]) => `${k} ${v.join(' ')}`).join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

/**
 * Same-origin /api through the dev proxy, so the API needs no CORS. The operator token is injected
 * here, server-side, so it never ships in the browser bundle (demo-only: production would put the
 * operator view behind real auth or an internal network).
 */
const proxy = {
  '/api': {
    target: env.API_URL || 'http://127.0.0.1:4000', // not PORT: dev launchers set PORT for this process
    configure: (p: { on: (e: 'proxyReq', cb: (req: { path?: string; setHeader: (k: string, v: string) => void }) => void) => void }) => {
      p.on('proxyReq', (req) => {
        if (req.path?.startsWith('/api/admin') && env.ADMIN_TOKEN) req.setHeader('x-admin-token', env.ADMIN_TOKEN);
      });
    },
  },
};

export default defineConfig({
  envDir: ENV_DIR,
  plugins: [react()],
  server: { port: 5173, proxy, headers: securityHeaders(true) },
  preview: { port: 4173, proxy, headers: securityHeaders(false) },
});
