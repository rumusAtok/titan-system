'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Badge, Card, EmptyState, KeyValue, PageHeader, QueryView, Stat, StatusBadge } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, number, titleCase } from '@/lib/format';

function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'not measured';
  if (value < 120) return `${number(value, value < 10 ? 1 : 0)} s`;
  if (value < 7200) return `${number(value / 60, 1)} min`;
  return `${number(value / 3600, 1)} h`;
}

function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} kB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export default function DisasterRecoveryPage() {
  const { hasRole } = useAuth();
  const canSeeHealth = !hasRole('dr_operator', 'platform_admin') || hasRole('tenant_admin', 'dr_operator', 'platform_admin');
  const dr = useQuery({ queryKey: ['dr', 'status'], queryFn: () => api('/api/platform/dr/status'), refetchInterval: 10_000 });
  const health = useQuery({ queryKey: ['platform', 'health'], queryFn: () => api('/api/platform/health'), refetchInterval: 10_000, enabled: canSeeHealth });
  const operator = hasRole('dr_operator');

  return (
    <>
      <PageHeader
        title="Disaster recovery"
        description="Status of the primary and recovery environments, replication, backups and recovery drills. Every value is read from its source when this page loads."
        actions={dr.data ? <Badge>Checked {ago(dr.data.checked_at)}</Badge> : undefined}
      />

      <QueryView query={dr} what="Disaster-recovery status">
        {(d: any) => {
          const standby = d.replication.standbys[0];
          const lastFailover = d.drills.find((x: any) => x.type === 'failover' && x.result === 'passed');
          const lastRestore = d.drills.find((x: any) => x.type === 'backup-restore' && x.result === 'passed');
          return (
            <>
              <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4" role="note">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
                <p className="text-sm text-amber-900">
                  <span className="font-semibold">{titleCase(d.topology.kind)}.</span> {d.topology.notice}
                </p>
              </div>

              <dl className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat
                  label="Primary database"
                  value={d.primary.database.reachable ? titleCase(d.primary.database.role) : 'Unreachable'}
                  hint={d.primary.database.reachable ? `PostgreSQL ${d.primary.database.version} · LSN ${d.primary.database.lsn}` : d.primary.database.error}
                  tone={d.primary.database.reachable && d.primary.database.role === 'primary' ? 'ok' : 'danger'}
                />
                <Stat
                  label="Recovery database"
                  value={!d.recovery.configured ? 'Not configured' : d.recovery.database.reachable ? titleCase(d.recovery.database.role) : 'Not running'}
                  hint={d.recovery.database.reachable ? `LSN ${d.recovery.database.lsn}${d.recovery.database.wal_receiver_status ? ` · receiver ${d.recovery.database.wal_receiver_status}` : ''}` : 'Start the dr-lab profile to run a standby'}
                  tone={d.recovery.database.reachable ? (d.recovery.database.role === 'standby' ? 'ok' : 'warn') : 'neutral'}
                />
                <Stat
                  label="Replication lag"
                  value={standby ? bytes(standby.replay_lag_bytes) : '—'}
                  hint={standby ? `${titleCase(standby.state)} · ${standby.sync_state} · ${standby.replay_lag_seconds === null ? 'no time lag reported' : `${number(standby.replay_lag_seconds, 2)} s behind`}` : 'No standby is streaming from the primary'}
                  tone={standby ? (standby.state === 'streaming' ? 'ok' : 'warn') : 'neutral'}
                />
                <Stat
                  label="Latest backup"
                  value={d.backups.latest ? ago(d.backups.latest.created_at) : 'None'}
                  hint={d.backups.latest ? `${d.backups.latest.databases.length} databases · ${bytes(d.backups.latest.total_bytes)} · ${d.backups.latest.verified ? `restore verified ${ago(d.backups.latest.verified.at)}` : 'not yet restore-tested'}` : 'No backup has been taken'}
                  tone={d.backups.latest ? (d.backups.latest.verified?.result === 'passed' ? 'ok' : 'warn') : 'danger'}
                />
              </dl>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <Card title="Recovery objectives and observed results" description="Targets are engineering objectives. Observed values come only from executed drills in this laboratory." padded={false}>
                  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
                    <table className="min-w-full divide-y divide-line text-sm">
                      <caption className="sr-only">Recovery objectives per tier and the latest observed values</caption>
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                        <tr>
                          <th scope="col" className="px-4 py-2">Tier</th>
                          <th scope="col" className="px-4 py-2 text-right">Target RTO</th>
                          <th scope="col" className="px-4 py-2 text-right">Target RPO</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {Object.entries(d.objectives).map(([tier, o]: [string, any]) => (
                          <tr key={tier}>
                            <td className="px-4 py-2">
                              <span className="font-medium">{titleCase(tier)}</span>
                              <span className="block text-xs text-ink-muted">{o.description}</span>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{seconds(o.rto_seconds)}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{seconds(o.rpo_seconds)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-line p-4">
                    <KeyValue
                      items={[
                        ['Observed RTO, failover drill', lastFailover ? `${seconds(lastFailover.observed?.rto_seconds)} (${dateTime(lastFailover.started_at)})` : 'No successful failover drill recorded'],
                        ['Observed RPO, failover drill', lastFailover ? seconds(lastFailover.observed?.rpo_seconds) : '—'],
                        ['Observed restore time, backup drill', lastRestore ? `${seconds(lastRestore.observed?.rto_seconds)} (${dateTime(lastRestore.started_at)})` : 'No successful restore drill recorded'],
                        ['Observed data loss window, backup drill', lastRestore ? seconds(lastRestore.observed?.rpo_seconds) : '—'],
                      ]}
                    />
                    <p className="mt-3 text-xs text-ink-muted">Laboratory measurements on one host with small synthetic datasets. They do not predict production recovery times.</p>
                  </div>
                </Card>

                <Card title="Event stream" description="NATS JetStream">
                  {d.events.reachable ? (
                    <KeyValue
                      items={[
                        ['Stream', d.events.stream],
                        ['Messages retained', number(d.events.messages)],
                        ['Size', bytes(d.events.bytes)],
                        ['Last message', ago(d.events.last_message_at)],
                        ['Consumers', String(d.events.consumers)],
                        ['Replicas', String(d.events.replicas)],
                        ['Replicated to recovery site', d.events.replicated_to_dr ? 'Yes' : 'No (single broker in this lab)'],
                      ]}
                    />
                  ) : (
                    <p className="text-sm text-amber-800" role="alert">The event broker could not be reached.</p>
                  )}
                  <p className="mt-3 text-xs text-ink-muted">Unpublished events survive a database failover because each service's outbox is part of its replicated database.</p>
                  {d.primary.wal_archiving && (
                    <p className="mt-2 text-xs text-ink-muted">
                      WAL archiving: {number(Number(d.primary.wal_archiving.archived_count))} segment(s) archived, {number(Number(d.primary.wal_archiving.failed_count))} failure(s); last archived {ago(d.primary.wal_archiving.last_archived_time)}.
                    </p>
                  )}
                </Card>

                <Card title="Recovery test history" description="Reports generated by the drill scripts" padded={false}>
                  {d.drills.length === 0 ? (
                    <EmptyState title="No drills have been run">Run a drill from the command line; its report appears here.</EmptyState>
                  ) : (
                    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
                      <table className="min-w-full divide-y divide-line text-sm" data-testid="drill-history">
                        <caption className="sr-only">Recovery drills</caption>
                        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                          <tr>
                            <th scope="col" className="px-4 py-2">Started</th>
                            <th scope="col" className="px-4 py-2">Type</th>
                            <th scope="col" className="px-4 py-2">Result</th>
                            <th scope="col" className="px-4 py-2 text-right">Observed RTO</th>
                            <th scope="col" className="px-4 py-2 text-right">Observed RPO</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {d.drills.map((x: any) => (
                            <tr key={x.drill_id}>
                              <td className="whitespace-nowrap px-4 py-2">{dateTime(x.started_at)}</td>
                              <td className="px-4 py-2">{titleCase(x.type)}</td>
                              <td className="px-4 py-2"><Badge tone={x.result === 'passed' ? 'ok' : 'danger'}>{titleCase(x.result)}</Badge></td>
                              <td className="px-4 py-2 text-right tabular-nums">{seconds(x.observed?.rto_seconds)}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{seconds(x.observed?.rpo_seconds)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <Card title="Backups" description="Logical backups with checksums" padded={false}>
                  {d.backups.items.length === 0 ? (
                    <EmptyState title="No backups" />
                  ) : (
                    <ul className="max-h-72 divide-y divide-line overflow-y-auto" tabIndex={0} aria-label="Backups">
                      {d.backups.items.map((b: any) => (
                        <li key={b.backup_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                          <span>
                            <span className="font-mono text-xs">{b.backup_id}</span>
                            <span className="block text-xs text-ink-muted">{dateTime(b.created_at)} · {b.databases} databases · {bytes(b.total_bytes)}</span>
                          </span>
                          <Badge tone={b.verified?.result === 'passed' ? 'ok' : b.verified ? 'danger' : 'neutral'}>{b.verified ? `Restore ${b.verified.result}` : 'Not restore-tested'}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <div className="mt-6">
                <Card title="Recovery controls" description="Operator only">
                  {operator ? (
                    <div className="space-y-3 text-sm text-ink" data-testid="recovery-controls">
                      <p>
                        Recovery actions are deliberately not triggered from the browser. A failover is a controlled, operator-confirmed procedure run from the
                        operations workstation, where the operator sees each check before promotion and can abort safely.
                      </p>
                      <ul className="list-disc space-y-1 pl-5">
                        <li>Backup and restore test: <code className="rounded bg-slate-100 px-1 font-mono text-xs">npm run dr:restore-drill</code></li>
                        <li>Failover drill (asks for confirmation before promotion): <code className="rounded bg-slate-100 px-1 font-mono text-xs">npm run dr:failover-drill</code></li>
                        <li>Controlled failback: <code className="rounded bg-slate-100 px-1 font-mono text-xs">npm run dr:failback</code></li>
                      </ul>
                      <p className="text-xs text-ink-muted">See the failover and failback runbook for the full procedure, the abort points and the production differences.</p>
                    </div>
                  ) : (
                    <p className="text-sm text-ink-muted" data-testid="recovery-controls-locked">Recovery controls are available to DR operators only. You can view status but not operate recovery.</p>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </QueryView>

      <div className="mt-6">
        <Card title="Service health" description="Readiness of each service, probed now by the gateway" padded={false}>
          <QueryView query={health} what="Service health">
            {(h: any) => (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Scrollable table">
                <table className="min-w-full divide-y divide-line text-sm" data-testid="service-health">
                  <caption className="sr-only">Service health</caption>
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2">Service</th>
                      <th scope="col" className="px-4 py-2">Status</th>
                      <th scope="col" className="px-4 py-2">Database</th>
                      <th scope="col" className="px-4 py-2">Event broker</th>
                      <th scope="col" className="px-4 py-2">Criticality</th>
                      <th scope="col" className="px-4 py-2 text-right">Probe</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {h.services.map((s: any) => (
                      <tr key={s.service}>
                        <td className="px-4 py-2 font-medium">{s.service}</td>
                        <td className="px-4 py-2"><StatusBadge status={s.status} /></td>
                        <td className="px-4 py-2">{s.checks?.database ? titleCase(s.checks.database) : '—'}</td>
                        <td className="px-4 py-2">{s.checks?.broker ? titleCase(s.checks.broker) : '—'}</td>
                        <td className="px-4 py-2">{s.critical ? 'Critical' : 'Non-critical'}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.latency_ms === null ? '—' : `${s.latency_ms} ms`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
