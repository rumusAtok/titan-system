# Runbook: failover and failback

Scope: the DR lab on one workstation (executed; see the
[verification report](../testing/verification-report.md)). The regional notes at the end are a
plan, not a tested procedure.

Failover is **operator-confirmed**. Nothing promotes the standby automatically.

## Before you start

| Check | Command | Expect |
| --- | --- | --- |
| Standby is running and streaming | `./scripts/titan.ps1 status` and the DR dashboard (`/dr/`), or `docker compose exec postgres psql -U postgres -Atc "select application_name, state from pg_stat_replication"` | `recovery-site|streaming` |
| You know why you are failing over | — | The primary database is lost or unusable, and restarting it is not possible or not safe |

If the primary can simply be restarted, restart it. Failover is for when it cannot.

## Failover

```powershell
npm run dr:failover-drill
```

The script simulates the failure (it kills the primary) and then follows the real procedure.
For an actual failure the same steps apply from step 5 onward.

| # | Step | What you see | If it fails |
| --- | --- | --- | --- |
| pre | Standby streaming, primary is primary | `streaming, async, N bytes behind` | Do not continue; fix replication first |
| 1-3 | Record transactions, start continuous writes, note both LSNs | LSNs printed | — |
| 4 | Primary lost | `killed at <time>` | — |
| 5 | Confirm scope | `primary unreachable, standby reachable` | If the standby is also unreachable this is not a primary-only failure: stop and assess |
| 6 | **Fence** the old primary | `container is exited, automatic restart disabled` | Do **not** promote until the old primary is certain to stay down |
| 7 | Replication progress | `received X, replayed X` | The script waits until everything received is replayed |
| — | **Confirmation** | Prompt: type `FAILOVER` | Anything else aborts safely (below) |
| 8 | Promote | `recovery database is now primary (timeline N)` | See "Promotion failed" |
| 9 | Re-point services | `N services recreated with DB_HOST=postgres-dr and ready` | `docker compose ps`; check logs of the unhealthy service |
| 10 | Authentication | `new login succeeded` | Keycloak cannot reach its database: check `KC_DB_URL` host |
| 11 | Data integrity | recorded cases intact | Investigate before opening to users |
| 12 | Core transaction | a new application approved end to end | Do not open to users until this passes |
| 13 | Lost transactions | `K of N acknowledged writes lost` | K > 0 is expected to be possible with asynchronous replication; list them from the report and re-enter |
| 14 | Replay and reconciliation | outboxes drained, no duplicates | Duplicates would be a defect: capture the report |

The report (`infrastructure/disaster-recovery/reports/failover-<timestamp>.md`) records every
step, both LSNs, the observed RTO and RPO and the limitations of the drill.

For scripted runs: `npm run dr:failover-drill -- --confirm-failover`.

### Safe abort

At the confirmation prompt, answer anything other than `FAILOVER`. The script then:

1. re-enables and starts the original primary;
2. waits until services are ready again;
3. verifies the standby is still a standby;
4. writes a report with result `aborted`.

Nothing was promoted, so there is nothing to undo.

### State after a successful failover

- The platform runs on `postgres-dr` (now a primary).
- The old primary container is stopped and will not restart by itself. **Do not start it**: it
  has a diverged copy of the data and would accept writes (split brain).
- There is no standby until failback or a rebuild. Take a backup now:
  `npm run dr:backup -- --from-recovery`.
- A plain `docker compose up -d` would recreate services against the old database host. Until
  failback, pass the override: `$env:DB_HOST = "postgres-dr"` in the same shell.

### Manual recovery if the script stops part-way

| Situation | Action |
| --- | --- |
| Primary fenced, standby **not** promoted | Either continue manually from "Promote", or abort: `docker update --restart=unless-stopped titan-postgres-1; docker compose start postgres` |
| Standby promoted, services not re-pointed | `$env:DB_HOST = "postgres-dr"; docker compose --profile core --profile iot up -d --no-deps <services>` (never without `--no-deps`: that would start the old primary) |
| Promotion failed | `docker compose --profile dr-lab exec dr-tools psql -h postgres-dr -d postgres -c "select pg_is_in_recovery(), pg_last_wal_replay_lsn()"`; read `docker compose logs postgres-dr`; retry `select pg_promote(true, 60)` |

## Failback (planned outage, no data loss)

```powershell
npm run dr:failback
```

| # | Step | Notes |
| --- | --- | --- |
| pre | Recovery database is the acting primary; old primary is not running | Refuses to run otherwise |
| 1 | Record a transaction (must survive) | — |
| — | **Confirmation**: type `FAILBACK` | Otherwise nothing changes |
| 2 | Stop application services | Outage begins |
| 3 | Checkpoint and record the final write position | — |
| 4 | Rebuild the original primary as a standby of the recovery database | Its old data directory is deleted: after a failover it is obsolete |
| 5 | Wait until it has replayed past the recorded position | Guarantees nothing is lost |
| 6 | Stop the recovery database, then promote the original primary | Never two writable nodes |
| 7 | Rebuild the recovery database as a standby | — |
| 8 | Start services against the original primary | Outage ends |
| 9 | Validate | Recorded transaction present; new application approved |

Scripted: `npm run dr:failback -- --confirm-failback`.

In the lab the outage was about one minute. Both nodes are re-cloned with `pg_basebackup`,
which is only practical for small databases.

## Regional failover (planned, not tested)

The same fourteen steps apply (see the table in the
[DR architecture](../disaster-recovery/dr-architecture.md#failover-active-passive-operator-confirmed)).
The differences that matter:

| Lab | Region |
| --- | --- |
| Fencing = stop a container | Fencing must not depend on the failed site: block it at the network or load balancer, revoke its database credentials, or scale its workloads to zero through a control plane that is still reachable. If you cannot fence, do not promote |
| Promotion = `pg_promote()` | Change `spec.replica.enabled` to `false` on the DR `Cluster`, by a reviewed Git commit |
| Re-point = environment variable | DR workloads already point at the DR database; scale them from 0 (`values-dr-standby.yaml`) to serving |
| Traffic = unchanged | DNS or global load balancer switch; mind TTLs |
| Event stream = same broker | Consumers start on the mirrored stream in the DR region; expect replays, which the inbox absorbs |
| Devices = same broker | Devices must reach the DR broker endpoint (DNS or a second configured endpoint) |
| Decision = whoever runs the script | A named incident commander authorises; the decision and time are recorded |
| RTO includes | Detection, decision time, DNS propagation: none of which the lab measures |

Rehearse regional failover in a real staging pair before relying on these targets.
