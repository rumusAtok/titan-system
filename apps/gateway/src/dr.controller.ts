import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRoles } from '@titan/authentication';
import { EVENT_STREAM, Roles } from '@titan/contracts';
import { NatsClient } from '@titan/platform';
import pg from 'pg';

/**
 * Engineering TARGETS for recovery. They are objectives to test against,
 * not achieved figures; observed values come only from drill reports.
 */
const OBJECTIVES = {
  tier0: { description: 'Identity, case, workflow, incident, alert, telemetry ingestion', rto_seconds: 3600, rpo_seconds: 300 },
  tier1: { description: 'Assets, notifications, audit query, devices', rto_seconds: 4 * 3600, rpo_seconds: 900 },
  tier2: { description: 'Analytics, data pipeline, AI (rebuildable from tier 0/1 data)', rto_seconds: 24 * 3600, rpo_seconds: 3600 },
};

async function query<T>(url: string | undefined, sql: string): Promise<{ reachable: boolean; rows: T[]; error?: string }> {
  if (!url) return { reachable: false, rows: [], error: 'not configured' };
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000, statement_timeout: 3_000 });
  try {
    await client.connect();
    return { reachable: true, rows: (await client.query(sql)).rows as T[] };
  } catch (err) {
    return { reachable: false, rows: [], error: (err as Error).message.slice(0, 200) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readJsonFiles(dir: string, pick: (name: string) => string | null): Promise<any[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const name of names) {
    const file = pick(name);
    if (!file) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
    } catch {
      // unreadable or partially written file: skip it
    }
  }
  return out;
}

const DATABASE_STATUS = `
  SELECT pg_is_in_recovery() AS in_recovery,
         CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE pg_current_wal_lsn()::text END AS lsn,
         CASE WHEN pg_is_in_recovery() THEN extract(epoch FROM now() - pg_last_xact_replay_timestamp()) END AS seconds_since_last_replay,
         (SELECT status FROM pg_stat_wal_receiver LIMIT 1) AS wal_receiver_status,
         current_setting('server_version') AS version`;

const REPLICATION = `
  SELECT application_name, state, sync_state,
         pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint AS replay_lag_bytes,
         extract(epoch FROM replay_lag) AS replay_lag_seconds
    FROM pg_stat_replication`;

const ARCHIVER = `SELECT archived_count::bigint, failed_count::bigint, last_archived_time, last_failed_time FROM pg_stat_archiver`;

@ApiTags('platform')
@ApiBearerAuth()
@Controller('api/platform/dr')
export class DrController {
  constructor(@Inject(NatsClient) private readonly nats: NatsClient) {}

  @Get('status')
  @RequireRoles(Roles.DrOperator, Roles.PlatformAdmin, Roles.TenantAdmin)
  @ApiOperation({
    summary: 'Disaster-recovery status read from the real sources at request time',
    description: 'Database roles and replication from PostgreSQL statistics views, event stream state from JetStream, backups and drills from their generated manifests and reports.',
  })
  async status() {
    const artifacts = process.env.DR_ARTIFACTS_DIR ?? '/dr';
    const [primary, replication, archiver, standby, backups, drills] = await Promise.all([
      query<any>(process.env.MONITOR_DATABASE_URL, DATABASE_STATUS),
      query<any>(process.env.MONITOR_DATABASE_URL, REPLICATION),
      query<any>(process.env.MONITOR_DATABASE_URL, ARCHIVER),
      query<any>(process.env.DR_MONITOR_DATABASE_URL, DATABASE_STATUS),
      readJsonFiles(path.join(artifacts, 'backups'), (name) => path.join(name, 'manifest.json')),
      readJsonFiles(path.join(artifacts, 'reports'), (name) => (name.endsWith('.json') ? name : null)),
    ]);

    let events: Record<string, unknown> = { stream: EVENT_STREAM, reachable: false };
    try {
      const info = await this.nats.manager().streams.info(EVENT_STREAM);
      events = {
        stream: EVENT_STREAM,
        reachable: true,
        messages: info.state.messages,
        bytes: info.state.bytes,
        last_sequence: info.state.last_seq,
        last_message_at: info.state.last_ts,
        consumers: info.state.consumer_count,
        replicas: info.config.num_replicas,
        // Honest statement of the lab topology: one broker, nothing mirrored.
        replicated_to_dr: Boolean(info.config.mirror) || (info.cluster?.replicas?.length ?? 0) > 0,
      };
    } catch {
      // broker unreachable: reported as such
    }

    backups.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    drills.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const p = primary.rows[0];
    const s = standby.rows[0];

    return {
      checked_at: new Date().toISOString(),
      topology: {
        kind: process.env.TITAN_ENVIRONMENT ?? 'local-development',
        notice:
          'Single-host laboratory. Primary and recovery databases run as containers on one machine: this demonstrates the recovery procedure, it is not geographic disaster recovery and provides no high availability.',
      },
      objectives: OBJECTIVES,
      primary: {
        name: 'primary',
        database: primary.reachable
          ? { reachable: true, role: p.in_recovery ? 'standby' : 'primary', lsn: p.lsn, version: p.version }
          : { reachable: false, error: primary.error },
        wal_archiving: archiver.rows[0] ?? null,
      },
      recovery: {
        name: 'recovery (dr-lab)',
        configured: Boolean(process.env.DR_MONITOR_DATABASE_URL),
        database: standby.reachable
          ? {
              reachable: true,
              role: s.in_recovery ? 'standby' : 'primary',
              lsn: s.lsn,
              wal_receiver_status: s.wal_receiver_status,
              seconds_since_last_replay: s.seconds_since_last_replay === null ? null : Number(s.seconds_since_last_replay),
            }
          : { reachable: false, error: standby.error },
      },
      replication: {
        // From the primary's point of view: who is streaming from it and how far behind.
        streaming: replication.rows.some((r) => r.state === 'streaming'),
        standbys: replication.rows.map((r) => ({
          name: r.application_name,
          state: r.state,
          sync_state: r.sync_state,
          replay_lag_bytes: r.replay_lag_bytes === null ? null : Number(r.replay_lag_bytes),
          replay_lag_seconds: r.replay_lag_seconds === null ? null : Number(r.replay_lag_seconds),
        })),
      },
      events,
      backups: {
        count: backups.length,
        latest: backups[0] ?? null,
        items: backups.slice(0, 20).map((b) => ({
          backup_id: b.backup_id,
          created_at: b.created_at,
          type: b.type,
          databases: b.databases?.length ?? 0,
          total_bytes: b.total_bytes,
          verified: b.verified ?? null,
        })),
      },
      drills: drills.slice(0, 30).map((d) => ({
        drill_id: d.drill_id,
        type: d.type,
        started_at: d.started_at,
        finished_at: d.finished_at,
        result: d.result,
        observed: d.observed ?? null,
        objectives: d.objectives ?? null,
        summary: d.summary ?? null,
      })),
    };
  }
}
