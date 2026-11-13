import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const ConfigSchema = z.object({
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Least-privilege application role; subject to row-level security. */
  DATABASE_URL: z.string().optional(),
  /** Schema owner, used only to run migrations. */
  DATABASE_OWNER_URL: z.string().optional(),
  /** Name of the application role, substituted for {{APP_ROLE}} in migrations. */
  DB_APP_ROLE: z.string().optional(),
  MIGRATE_ON_START: bool.default(true),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  NATS_URL: z.string().default('nats://localhost:4222'),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_JWKS_URI: z.string().url(),
  OIDC_AUDIENCE: z.string().default('titan-api'),
  EVENT_MAX_DELIVER: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_POLL_MS: z.coerce.number().int().min(20).default(200),
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().min(1).default(24),
});

export type PlatformConfig = z.infer<typeof ConfigSchema>;

let cached: PlatformConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  if (cached && env === process.env) return cached;
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid service configuration: ${detail}`);
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}

export const CONFIG = Symbol('TITAN_CONFIG');
export const LOGGER = Symbol('TITAN_LOGGER');
