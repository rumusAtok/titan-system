import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from '@titan/observability';

export interface MigrationOptions {
  /** Connection string of the schema owner. */
  ownerUrl: string;
  /** Directory with the service's `NNNN_name.sql` files. */
  serviceDir?: string;
  /** Application role name substituted for `{{APP_ROLE}}`. */
  appRole?: string;
  logger?: Logger;
  /** How long to wait for the database to accept connections. */
  connectTimeoutMs?: number;
}

const PLATFORM_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
// Arbitrary constant: all TITAN migration runners on a database serialise on it.
const LOCK_KEY = 7_480_112;

async function listMigrations(dir: string, scope: string): Promise<{ version: string; file: string }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const bad = names.filter((n) => n.endsWith('.sql') && !FILE_PATTERN.test(n));
  if (bad.length) throw new Error(`migration files must be named NNNN_name.sql: ${bad.join(', ')}`);
  return names
    .filter((n) => FILE_PATTERN.test(n))
    .sort()
    .map((n) => ({ version: `${scope}/${n}`, file: path.join(dir, n) }));
}

async function connectWithRetry(url: string, timeoutMs: number, logger?: Logger): Promise<pg.Client> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      logger?.warn({ error: (err as Error).message }, 'database not reachable yet, retrying');
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw new Error(`could not connect to the database for migrations: ${(lastError as Error)?.message}`);
}

/**
 * Applies pending migrations in order. Each file runs in its own transaction
 * and is recorded with a checksum; an already-applied file whose content has
 * changed aborts the run instead of silently diverging.
 * Safe to run concurrently from several replicas (advisory lock).
 */
export async function runMigrations(options: MigrationOptions): Promise<string[]> {
  const { logger } = options;
  const client = await connectWithRetry(options.ownerUrl, options.connectTimeoutMs ?? 90_000, logger);
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const known = new Map<string, string>(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const pending = [
      ...(await listMigrations(PLATFORM_DIR, 'platform')),
      ...(options.serviceDir ? await listMigrations(options.serviceDir, 'service') : []),
    ];
    for (const m of pending) {
      const raw = await readFile(m.file, 'utf8');
      const checksum = createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex');
      const previous = known.get(m.version);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`migration ${m.version} was modified after being applied; add a new migration instead`);
        }
        continue;
      }
      if (raw.includes('{{APP_ROLE}}') && !options.appRole) {
        throw new Error(`migration ${m.version} needs DB_APP_ROLE to be configured`);
      }
      const sql = raw.replaceAll('{{APP_ROLE}}', pg.escapeIdentifier(options.appRole ?? ''));
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [m.version, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${m.version} failed: ${(err as Error).message}`);
      }
      applied.push(m.version);
      logger?.info({ migration: m.version }, 'migration applied');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  return applied;
}
