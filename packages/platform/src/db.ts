import pg from 'pg';

// Return NUMERIC and BIGINT as JS numbers. Values stored in these types by
// TITAN services (counts, sequence numbers, measurements) fit in a double.
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

/** Query interface bound to one open transaction. */
export interface Q {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Exactly one row, otherwise throws. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Runs a statement and returns the affected row count. */
  exec(sql: string, params?: unknown[]): Promise<number>;
}

function bind(client: pg.PoolClient): Q {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await client.query(sql, params)).rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []): Promise<T> {
      const rows = (await client.query(sql, params)).rows as T[];
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0]!;
    },
    async maybeOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      const rows = (await client.query(sql, params)).rows as T[];
      return rows[0] ?? null;
    },
    async exec(sql: string, params: unknown[] = []): Promise<number> {
      return (await client.query(sql, params)).rowCount ?? 0;
    },
  };
}

export interface DbOptions {
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
}

/**
 * Connection pool for a service-owned database.
 *
 * All access goes through `tx`, which opens a transaction and binds it to a
 * tenant via a transaction-local setting that the row-level security
 * policies read. Passing `null` leaves the tenant unset: tenant tables then
 * return no rows, which is what infrastructure work (outbox relay) wants.
 */
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string, options: DbOptions = {}) {
    this.pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      application_name: options.applicationName,
    });
    // An idle client erroring (e.g. database restart) must not crash the process.
    this.pool.on('error', () => undefined);
  }

  async tx<T>(tenantId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(bind(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection already broken; the pool discards it on release
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
