// Disaster-recovery drill: loss of the primary database and controlled
// failover to the standby (active-passive, operator-confirmed).
//
//   node scripts/dr/failover-drill.mjs [--confirm-failover]
//
// Without --confirm-failover the script stops before promotion and asks the
// operator to type FAILOVER. If the answer is anything else (or there is no
// terminal) it ABORTS SAFELY: the primary is started again and nothing is promoted.
//
// After a successful drill the platform runs on the recovery database and the
// old primary stays fenced. Run `npm run dr:failback` to return to the normal
// topology.
//
// This runs on one machine. It exercises the PROCEDURE; it is not geographic
// disaster recovery and its timings do not predict production.
import {
  api, approveCase, caseState, compose, confirm, containerHealth, iso, parseFlags, psql, rawApi, Report, runningApplicationServices, seconds, sh, sleep,
  submitCase, tryCompose, tryPsql, waitFor, waitHealthy, waitServicesReady,
} from './lib.mjs';
import { tokenFor } from '../lib/titan-client.mjs';

const PRIMARY = 'postgres';
const STANDBY = 'postgres-dr';
const flags = parseFlags(process.argv.slice(2), ['confirm-failover']);
const report = new Report('failover', { rto_seconds: 3600, rpo_seconds: 300, note: 'Tier 0 engineering objectives.' });
const e = report.data.evidence;
const tag = report.data.drill_id.slice(-8);

const primaryContainer = () => compose(['ps', '-aq', PRIMARY]).split(/\r?\n/)[0];
const lsnDiff = (a, b) => Number(psql(STANDBY, 'postgres', `SELECT pg_wal_lsn_diff('${a}', '${b}')`));

/** Writes one small transaction every 250 ms until stopped, recording which ones the platform acknowledged. */
function startWriter() {
  const acknowledged = [];
  let failed = 0;
  let stop = false;
  const loop = (async () => {
    let n = 0;
    while (!stop) {
      n += 1;
      const code = `DRF-${tag}-${String(n).padStart(4, '0')}`;
      try {
        const res = await rawApi('amy.assets', 'POST', '/api/asset/assets', { code, name: `Failover drill write ${n}`, category_code: 'DRAINAGE' });
        if (res.status === 201) acknowledged.push({ code, acknowledged_at: Date.now() });
        else failed += 1;
      } catch {
        failed += 1;
      }
      await sleep(250);
    }
  })();
  return { acknowledged, failures: () => failed, stop: async () => { stop = true; await loop; } };
}

let fenced = false;
let promoted = false;
let services = [];

try {
  console.log(`Failover drill ${report.data.drill_id}`);

  await report.step('Check preconditions: standby is streaming from the primary', async () => {
    report.check(containerHealth(STANDBY) === 'healthy', 'the recovery database is not running: start it with `docker compose --profile dr-lab up -d postgres-dr dr-tools`');
    report.check(psql(PRIMARY, 'postgres', 'SELECT pg_is_in_recovery()') === 'f', 'the primary is not in the primary role (was a previous failover left without failback?)');
    report.check(psql(STANDBY, 'postgres', 'SELECT pg_is_in_recovery()') === 't', 'the recovery database is not a standby');
    const row = await waitFor(() => {
      const r = psql(PRIMARY, 'postgres', "SELECT state || '|' || sync_state || '|' || pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) FROM pg_stat_replication WHERE application_name = 'recovery-site'");
      return r.startsWith('streaming') ? r : null;
    }, { timeoutMs: 60_000, intervalMs: 1_000, what: 'streaming replication' });
    const [state, sync, lag] = row.split('|');
    e.replication_before = { state, sync_state: sync, replay_lag_bytes: Number(lag) };
    services = runningApplicationServices();
    e.application_services = services;
    return `${state}, ${sync}, ${lag} bytes behind; ${services.length} application services running`;
  });

  await report.step('1. Generate representative transactions and record them', async () => {
    const approved = await submitCase(tag, 1);
    await approveCase(approved.id);
    const inReview = await submitCase(tag, 2);
    await waitFor(async () => (await caseState(inReview.id)) === 'in_review', { timeoutMs: 30_000, what: 'case to reach review' });
    e.transactions = { approved_case: approved, in_review_case: inReview };
    return `approved ${approved.reference_no}, in review ${inReview.reference_no}`;
  });

  const writer = startWriter();
  await report.step('2. Start continuous writes (used to measure data loss)', async () => {
    await waitFor(() => writer.acknowledged.length >= 12, { timeoutMs: 30_000, intervalMs: 250, what: 'continuous writes to be acknowledged' });
    return `${writer.acknowledged.length} writes acknowledged so far`;
  });

  await report.step('3. Verify standby replication immediately before the failure', async () => {
    const primaryLsn = psql(PRIMARY, 'postgres', 'SELECT pg_current_wal_lsn()');
    const replayLsn = psql(STANDBY, 'postgres', 'SELECT pg_last_wal_replay_lsn()');
    e.lsn_before_failure = { primary: primaryLsn, standby_replay: replayLsn, lag_bytes: lsnDiff(primaryLsn, replayLsn) };
    return `primary ${primaryLsn}, standby replayed ${replayLsn}`;
  });

  // ---------------------------------------------------------------- disaster
  const failedAt = Date.now();
  await report.step('4. Simulate loss of the primary database (SIGKILL)', async () => {
    sh('docker', ['kill', primaryContainer()]);
    e.primary_failed_at = iso(new Date(failedAt));
    return `killed at ${e.primary_failed_at}`;
  });

  await report.step('5. Detect the failure and confirm its scope', async () => {
    await waitFor(() => !tryPsql(PRIMARY, 'postgres', 'SELECT 1').ok, { timeoutMs: 20_000, what: 'the primary to be unreachable' });
    const health = await api('adam.admin', 'GET', '/api/platform/health').catch(() => null);
    // A service whose database is gone either reports it or stops answering its readiness probe in time.
    const down = health ? health.services.filter((s) => services.includes(s.service) && (s.checks?.database === 'down' || s.status === 'unavailable' || s.status === 'unreachable')).map((s) => s.service) : [];
    report.check(tryPsql(STANDBY, 'postgres', 'SELECT 1').ok, 'the recovery database is also unreachable: this is not a primary-only failure');
    e.failure_scope = { primary_database: 'unreachable', recovery_database: 'reachable', services_not_ready: down, platform_status: health?.status ?? 'gateway could not report' };
    return `primary unreachable, standby reachable, ${down.length} services not ready`;
  });

  await writer.stop();
  e.writes = { acknowledged_before_failure: writer.acknowledged.filter((w) => w.acknowledged_at <= failedAt).length, acknowledged_total: writer.acknowledged.length, refused_or_failed: writer.failures() };

  await report.step('6. Fence the failed primary so it cannot accept writes again', async () => {
    const id = primaryContainer();
    // In this lab fencing means: the container is stopped and may not restart on its own.
    sh('docker', ['update', '--restart=no', id]);
    tryCompose(['stop', PRIMARY]);
    const state = sh('docker', ['inspect', '-f', '{{.State.Status}}', id]);
    report.check(state !== 'running', `the old primary is still ${state}`);
    fenced = true;
    return `old primary container is ${state}, automatic restart disabled`;
  });

  await report.step('7. Inspect replication progress on the standby', async () => {
    const [receive, replay, lastReplay] = psql(STANDBY, 'postgres', "SELECT pg_last_wal_receive_lsn() || '|' || pg_last_wal_replay_lsn() || '|' || COALESCE(pg_last_xact_replay_timestamp()::text, '')").split('|');
    // Everything received must be replayed before promotion.
    await waitFor(() => psql(STANDBY, 'postgres', 'SELECT pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()') === 't', { timeoutMs: 30_000, what: 'the standby to replay everything it received' });
    e.standby_before_promotion = { received_lsn: receive, replayed_lsn: replay, last_replayed_transaction_at: lastReplay, bytes_beyond_last_known_primary_lsn: lsnDiff(replay, e.lsn_before_failure.primary) };
    return `received ${receive}, replayed ${replay}`;
  });

  // ------------------------------------------------------- operator decision
  const go = await confirm(
    'FAILOVER',
    flags['confirm-failover'],
    `The primary is down and fenced. The standby has replayed up to ${e.standby_before_promotion.replayed_lsn}.\nPromoting it makes the recovery site the new primary; the old primary must then be rebuilt before it can return.`,
  );
  e.operator_confirmation = { given: go, at: iso(), method: flags['confirm-failover'] ? 'command-line flag' : 'typed phrase' };

  if (!go) {
    await report.step('Abort safely: restart the original primary, promote nothing', async () => {
      const id = primaryContainer();
      sh('docker', ['update', '--restart=unless-stopped', id]);
      compose(['start', PRIMARY]);
      fenced = false;
      await waitHealthy([PRIMARY], 120_000);
      await waitServicesReady(services);
      report.check(psql(STANDBY, 'postgres', 'SELECT pg_is_in_recovery()') === 't', 'the standby changed role during an aborted drill');
      return 'primary restarted, standby still a standby, services ready';
    });
    report.data.limitations.push('Failover was not confirmed by the operator; the drill exercised detection, fencing and the safe-abort path only.');
    report.finish('aborted', 'Operator did not confirm the failover. The original primary was restarted and no promotion took place.');
    process.exit(2);
  }

  await report.step('8. Promote the recovery database', async () => {
    report.check(psql(STANDBY, 'postgres', 'SELECT pg_promote(true, 60)') === 't', 'pg_promote did not complete');
    promoted = true;
    report.check(psql(STANDBY, 'postgres', 'SELECT pg_is_in_recovery()') === 'f', 'the recovery database is still in recovery');
    // The new timeline is recorded in the control file by the first checkpoint after promotion.
    psql(STANDBY, 'postgres', 'CHECKPOINT');
    const timeline = psql(STANDBY, 'postgres', 'SELECT timeline_id FROM pg_control_checkpoint()');
    e.promotion = { promoted_at: iso(), timeline };
    return `recovery database is now primary (timeline ${timeline})`;
  });

  await report.step('9. Activate services against the recovery database', async () => {
    // --no-deps: never let compose start the fenced primary as a dependency.
    compose(['up', '-d', '--no-deps', ...services], { DB_HOST: STANDBY });
    await waitHealthy(services.filter((s) => s !== 'sensor-simulator'), 300_000);
    await waitServicesReady(services, 300_000);
    return `${services.length} services recreated with DB_HOST=${STANDBY} and ready`;
  });

  await report.step('10. Validate authentication (identity store recovered)', async () => {
    // A brand-new login proves Keycloak works on the recovered identity database.
    const res = await fetch(`${(await import('../lib/titan-client.mjs')).config.keycloakUrl}/realms/titan/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'password', client_id: 'titan-cli', username: 'fiona.final', password: (await import('../lib/titan-client.mjs')).config.demoPassword }),
    });
    report.check(res.status === 200, `login returned ${res.status}`);
    report.check((await rawApi(null, 'GET', '/api/case/cases')).status === 401, 'unauthenticated access is not refused after failover');
    report.check((await rawApi('alice.applicant', 'GET', '/api/tenant/tenants')).status === 403, 'role enforcement is not working after failover');
    return 'new login succeeded; authentication and role checks enforced';
  });

  await report.step('11. Validate data integrity of recorded transactions', async () => {
    const t = e.transactions;
    report.check((await caseState(t.approved_case.id)) === 'approved', 'the approved case is not approved after failover');
    report.check((await caseState(t.in_review_case.id)) === 'in_review', 'the in-review case changed status');
    const instance = await api('victor.validator', 'GET', `/api/workflow/instances/by-subject/case/${t.approved_case.id}`);
    report.check(instance.decisions.length === 3, `the approved case has ${instance.decisions.length} decisions instead of 3`);
    return 'recorded cases and their decision history are intact';
  });

  let recoveredAt = 0;
  await report.step('12. Validate a core transaction end to end on the recovery site', async () => {
    const fresh = await submitCase(tag, 99);
    await approveCase(fresh.id);
    recoveredAt = Date.now();
    e.post_failover_transaction = fresh;
    return `new application ${fresh.reference_no} submitted and approved through all stages`;
  });

  await report.step('13. Detect lost transactions', async () => {
    const present = new Set((await api('amy.assets', 'GET', `/api/asset/assets?q=DRF-${tag}&limit=500`)).map((a) => a.code));
    const beforeFailure = writer.acknowledged.filter((w) => w.acknowledged_at <= failedAt);
    const lost = beforeFailure.filter((w) => !present.has(w.code));
    e.lost_writes = lost.map((w) => ({ code: w.code, acknowledged_at: iso(new Date(w.acknowledged_at)) }));
    report.data.observed.data_loss_transactions = lost.length;
    // RPO = how far back from the failure the oldest lost acknowledged write lies.
    report.data.observed.rpo_seconds = lost.length ? seconds(failedAt - Math.min(...lost.map((w) => w.acknowledged_at))) : 0;
    e.rpo_measurement = lost.length
      ? 'Acknowledged writes missing after failover; RPO is the age of the oldest one at the moment of failure.'
      : `None of the ${beforeFailure.length} writes acknowledged before the failure was lost. Measurement resolution is the 250 ms write interval; asynchronous replication can lose the last moments before a failure.`;
    return `${lost.length} of ${beforeFailure.length} acknowledged writes lost`;
  });

  await report.step('14. Verify event replay is idempotent and reconcile unfinished events', async () => {
    // Events committed but unpublished at the moment of failure sit in the replicated outboxes
    // and are published now; consumers must not repeat work they had already done.
    await waitFor(() => ['titan_case', 'titan_workflow', 'titan_asset', 'titan_incident', 'titan_alert']
      .every((db) => psql(STANDBY, db, 'SELECT count(*) FROM outbox WHERE published_at IS NULL') === '0'), { timeoutMs: 60_000, intervalMs: 1_000, what: 'outboxes to drain' });
    const duplicateInstances = Number(psql(STANDBY, 'titan_workflow', 'SELECT count(*) FROM (SELECT subject_id FROM workflow_instances GROUP BY subject_type, subject_id HAVING count(*) > 1) d'));
    const duplicateTasks = Number(psql(STANDBY, 'titan_workflow', 'SELECT count(*) FROM (SELECT 1 FROM workflow_tasks GROUP BY instance_id, cycle, stage_key, role HAVING count(*) > 1) d'));
    const duplicateIncidents = Number(psql(STANDBY, 'titan_incident', 'SELECT count(*) FROM (SELECT 1 FROM incidents WHERE source_id IS NOT NULL GROUP BY tenant_id, source_type, source_id HAVING count(*) > 1) d'));
    report.check(duplicateInstances + duplicateTasks + duplicateIncidents === 0, `duplicates after replay: ${duplicateInstances} instances, ${duplicateTasks} tasks, ${duplicateIncidents} incidents`);
    const t = e.transactions;
    const pending = await api('victor.validator', 'GET', `/api/workflow/tasks?subject_id=${t.in_review_case.id}`);
    report.check(pending.length === 1, `the in-review case has ${pending.length} pending tasks instead of 1`);
    const notifications = (await api('alice.applicant', 'GET', '/api/notification/notifications?limit=200')).filter((n) => n.reference_id === t.approved_case.id && n.category === 'case.approved');
    report.check(notifications.length === 1, `the applicant has ${notifications.length} approval notifications instead of 1`);
    const deadLetters = Number(psql(STANDBY, 'titan_workflow', "SELECT count(*) FROM dead_letters WHERE failed_at > now() - interval '15 minutes'"));
    e.reconciliation = { outboxes_drained: true, duplicate_workflow_instances: 0, duplicate_tasks: 0, duplicate_incidents: 0, approval_notifications_for_recorded_case: 1, recent_dead_letters_workflow: deadLetters };
    return 'outboxes drained; no duplicate instances, tasks, incidents or notifications';
  });

  report.data.observed.rto_seconds = seconds(recoveredAt - failedAt);
  e.timing = {
    primary_failed_at: iso(new Date(failedAt)),
    core_transaction_verified_at: iso(new Date(recoveredAt)),
    explanation: 'Observed RTO = from the kill of the primary to a new application approved end to end on the recovery site. It includes detection, fencing, the (scripted) operator confirmation, promotion and service restart.',
  };
  e.traffic_redirection = 'Not applicable in this lab: the gateway address is unchanged and services were re-pointed by configuration. In production this step is a DNS / global load balancer change.';
  e.next_steps = ['The old primary is fenced and must be rebuilt as a standby before it is used again.', 'Run `npm run dr:failback` for a controlled return to the normal topology.'];
  report.data.limitations.push(
    'Primary and recovery databases are containers on one host: no network partition, no site loss, no geographic separation was exercised.',
    'Fencing was simulated by stopping the container and disabling its restart policy. Production fencing needs an independent mechanism (network isolation or power fencing) and quorum.',
    'Replication is asynchronous: writes acknowledged in the last moments before a failure can be lost. This drill detects such loss but, with a local link, it rarely occurs.',
    'The operator confirmation was supplied by a flag in this scripted run; a human decision takes longer and is part of real RTO.',
    'NATS JetStream, MQTT broker state and the analytical lake were not failed over: they stayed up on the same host.',
    'Small synthetic dataset; timings do not predict production.',
  );
  report.finish(
    'passed',
    `Primary killed and fenced; standby promoted after confirmation; ${services.length} services re-pointed. Observed RTO ${report.data.observed.rto_seconds} s, observed RPO ${report.data.observed.rpo_seconds} s (${report.data.observed.data_loss_transactions} acknowledged writes lost). The platform now runs on the recovery database; failback is pending.`,
  );
} catch (err) {
  report.data.limitations.push('The drill did not complete; see the failed step.');
  e.state_at_failure = { primary_fenced: fenced, standby_promoted: promoted };
  if (fenced && !promoted) console.error('\nThe primary is fenced and the standby was NOT promoted. To return to normal: docker update --restart=unless-stopped <postgres container> ; docker compose start postgres');
  if (promoted) console.error('\nThe standby WAS promoted. Do not start the old primary. Run `npm run dr:failback` once services are healthy on the recovery database.');
  report.finish('failed', err.message);
  process.exitCode = 1;
}
void tokenFor;
