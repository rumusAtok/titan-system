#!/usr/bin/env node
/**
 * Standalone migration runner, for running migrations as a separate step
 * (e.g. a Kubernetes Job / init container) instead of at service start:
 *
 *   DATABASE_OWNER_URL=... DB_APP_ROLE=... node packages/platform/dist/migrate-cli.js services/case-service/migrations
 */
import path from 'node:path';
import { createLogger } from '@titan/observability';
import { runMigrations } from './migrate.js';

const dir = process.argv[2];
const ownerUrl = process.env.DATABASE_OWNER_URL;
const logger = createLogger(process.env.SERVICE_NAME ?? 'migrate');

if (!ownerUrl) {
  logger.error('DATABASE_OWNER_URL is required');
  process.exit(2);
}

try {
  const applied = await runMigrations({
    ownerUrl,
    serviceDir: dir ? path.resolve(dir) : undefined,
    appRole: process.env.DB_APP_ROLE,
    logger,
  });
  logger.info({ applied }, 'migrations complete');
} catch (err) {
  logger.error({ error: (err as Error).message }, 'migrations failed');
  process.exit(1);
}
