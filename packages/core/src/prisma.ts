import { PrismaClient } from '@prisma/client';
import { config } from './config';

if (!config.databaseUrl) throw new Error('DATABASE_URL must be set');

/** Small pool per process: replicas × pool must stay under Postgres max_connections (PgBouncer is the upgrade). */
function withPool(url: string, size: number): string {
  const u = new URL(url);
  if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', String(size));
  return u.toString();
}

export function createPrisma(poolSize: number): PrismaClient {
  return new PrismaClient({ datasourceUrl: withPool(config.databaseUrl, poolSize) });
}

let shared: PrismaClient | undefined;
export const db = (): PrismaClient => (shared ??= createPrisma(Number(process.env.DB_POOL ?? config.worker.dbPool)));
