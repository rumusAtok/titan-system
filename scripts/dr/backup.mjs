// Logical backup of every service database (and the identity store).
//
//   node scripts/dr/backup.mjs [--from-recovery]
//
// One custom-format pg_dump per database plus the cluster globals (roles),
// with a manifest holding sizes, SHA-256 checksums, the WAL position and row
// counts of key tables. Backups land in infrastructure/disaster-recovery/backups/
// (git-ignored: they contain data and role password hashes).
//
// A backup is only trustworthy once it has been restored: run
// `npm run dr:restore-drill`, which backs up, restores into an isolated
// instance and verifies the result.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_DIR, compose, containerHealth, iso, parseFlags, psql, stamp, tools } from './lib.mjs';

/** Tables whose row counts are recorded as a coarse completeness check. */
export const KEY_TABLES = {
  titan_tenant: ['tenants', 'departments'],
  titan_case: ['cases', 'case_status_history'],
  titan_workflow: ['workflow_instances', 'workflow_tasks', 'workflow_decisions'],
  titan_audit: ['audit_events'],
  titan_asset: ['assets'],
  titan_incident: ['incidents'],
  titan_device: ['devices'],
  titan_alert: ['alert_rules', 'alerts'],
  titan_notification: ['notifications'],
  keycloak: ['user_entity'],
};

export function rowCounts(host) {
  const counts = {};
  for (const [database, tables] of Object.entries(KEY_TABLES)) {
    for (const table of tables) counts[`${database}.${table}`] = Number(psql(host, database, `SELECT count(*) FROM ${table}`));
  }
  return counts;
}

export async function takeBackup({ host = 'postgres' } = {}) {
  if (containerHealth('dr-tools') === 'absent') compose(['up', '-d', '--no-deps', 'dr-tools']);
  const id = `backup-${stamp()}`;
  const dir = `/backups/${id}`;
  const started = Date.now();
  tools(['mkdir', '-p', dir]);

  const databases = psql(host, 'postgres', "SELECT datname FROM pg_database WHERE datname LIKE 'titan\\_%' OR datname = 'keycloak' ORDER BY 1").split(/\r?\n/).filter(Boolean);
  // Counts are taken before and after dumping: each dump is its own consistent
  // snapshot somewhere in between, so a restored count must fall inside these bounds.
  const countsBefore = rowCounts(host);
  const lsn = psql(host, 'postgres', 'SELECT CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END');
  const version = psql(host, 'postgres', "SELECT current_setting('server_version')");

  const entries = [];
  for (const database of databases) {
    const file = `${database}.dump`;
    tools(['pg_dump', '-h', host, '-d', database, '--format=custom', '--compress=6', '--no-password', '-f', `${dir}/${file}`]);
    const [sha256] = tools(['sha256sum', `${dir}/${file}`]).split(/\s+/);
    const size = Number(tools(['stat', '-c', '%s', `${dir}/${file}`]));
    // Reading the table of contents proves the archive is structurally intact.
    const objects = tools(['pg_restore', '--list', `${dir}/${file}`]).split(/\r?\n/).filter((l) => l && !l.startsWith(';')).length;
    entries.push({ name: database, file, size_bytes: size, sha256, archive_objects: objects });
  }
  tools(['pg_dumpall', '-h', host, '--globals-only', '--no-password', '-f', `${dir}/globals.sql`]);
  const [globalsSha] = tools(['sha256sum', `${dir}/globals.sql`]).split(/\s+/);
  const countsAfter = rowCounts(host);

  const manifest = {
    backup_id: id,
    created_at: iso(new Date(started)),
    completed_at: iso(),
    duration_seconds: Math.round((Date.now() - started) / 100) / 10,
    type: 'logical',
    tool: 'pg_dump (custom format), one archive per database',
    source_host: host,
    postgres_version: version,
    wal_lsn_at_start: lsn,
    databases: entries,
    globals: { file: 'globals.sql', sha256: globalsSha, note: 'roles and their password hashes: treat this backup as secret material' },
    total_bytes: entries.reduce((n, e) => n + e.size_bytes, 0),
    row_counts: { before: countsBefore, after: countsAfter },
    verified: null,
  };
  mkdirSync(path.join(BACKUP_DIR, id), { recursive: true });
  writeFileSync(path.join(BACKUP_DIR, id, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const flags = parseFlags(process.argv.slice(2), ['from-recovery']);
  takeBackup({ host: flags['from-recovery'] ? 'postgres-dr' : 'postgres' })
    .then((m) => {
      console.log(`Backup ${m.backup_id}: ${m.databases.length} databases, ${(m.total_bytes / 1024 / 1024).toFixed(1)} MB in ${m.duration_seconds} s`);
      console.log('Not yet restore-tested. Run `npm run dr:restore-drill` to verify a backup end to end.');
    })
    .catch((err) => {
      console.error(`Backup failed: ${err.message}`);
      process.exit(1);
    });
}
