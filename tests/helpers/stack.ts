// Helpers for tests that run against the REAL local stack. Nothing here mocks
// a service, database, broker or identity provider.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect, headers, type NatsConnection } from '@nats-io/transport-node';
import mqtt, { type MqttClient } from 'mqtt';
import pg from 'pg';
import { api, claimsOf, config, rawApi, sleep, TENANT_A, TENANT_B, tokenFor, waitFor } from '../../scripts/lib/titan-client.mjs';

export { api, claimsOf, config, rawApi, sleep, TENANT_A, TENANT_B, tokenFor, waitFor };

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Short unique suffix so repeated test runs never collide on unique columns. */
export const unique = (prefix = '') => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

// --- docker compose ------------------------------------------------------------

export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '--profile', 'core', '--profile', 'iot', ...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function stopService(...services: string[]): void {
  compose('stop', ...services);
}

/** Starts services and waits until the gateway reports each of them ready. */
export async function startService(...services: string[]): Promise<void> {
  compose('start', ...services);
  await waitFor(
    async () => {
      const health = await api('adam.admin', 'GET', '/api/platform/health');
      return services.every((name) => health.services.find((s: any) => s.service === name)?.status === 'ok' || !health.services.some((s: any) => s.service === name));
    },
    { timeoutMs: 90_000, intervalMs: 1_000, what: `${services.join(', ')} to become ready` },
  );
}

// --- PostgreSQL (direct, as a service's application role) -------------------------

/** Connects as `<service>_app`, the same least-privilege role the service uses. */
export async function connectAsAppRole(service: string, database = `titan_${service}`): Promise<pg.Client> {
  const role = `${service}_app`;
  const client = new pg.Client({
    host: '127.0.0.1',
    port: Number(config.env.POSTGRES_HOST_PORT ?? 5432),
    user: role,
    password: `${config.env.DB_DEV_PASSWORD}_${role}`,
    database,
  });
  await client.connect();
  return client;
}

// --- MQTT (a simulated sensor) ----------------------------------------------------

let mqttClient: MqttClient | undefined;

export async function sensor(): Promise<MqttClient> {
  mqttClient ??= await mqtt.connectAsync(config.mqttUrl, {
    clientId: `test-sensor-${randomUUID()}`,
    username: config.mqttUser,
    password: config.mqttPassword,
  });
  return mqttClient;
}

export interface Reading {
  sensor: string;
  value: number;
}

/** Publishes one telemetry message over MQTT (QoS 1) and returns its message id. */
export async function publishTelemetry(
  tenantId: string,
  deviceId: string,
  readings: Reading[],
  options: { messageId?: string; observedAt?: Date; raw?: string } = {},
): Promise<string> {
  const messageId = options.messageId ?? `test-${randomUUID()}`;
  const payload = options.raw ?? JSON.stringify({ message_id: messageId, observed_at: (options.observedAt ?? new Date()).toISOString(), readings });
  await (await sensor()).publishAsync(`titan/${tenantId}/devices/${deviceId}/telemetry`, payload, { qos: 1 });
  return messageId;
}

/** Registers a fresh device for one test and waits until telemetry-service knows it. */
export async function registerTestDevice(admin = 'adam.admin', expectedIntervalSeconds = 5) {
  const tenantId = claimsOf(await tokenFor(admin)).tenant_id as string;
  const serial = unique('TEST-');
  const device = await api(admin, 'POST', '/api/device/devices', {
    serial_no: serial,
    name: `Test sensor ${serial}`,
    device_type: 'flood-monitoring-station',
    latitude: 3.07,
    longitude: 101.52,
    expected_interval_seconds: expectedIntervalSeconds,
    config: { synthetic: true, test: true },
    sensors: [
      { kind: 'water_level', unit: 'm', min_valid: 0, max_valid: 15 },
      { kind: 'rainfall', unit: 'mm/h', min_valid: 0, max_valid: 500 },
    ],
  });
  // The device reaches telemetry-service through an event; probe until a reading is accepted.
  await waitFor(
    async () => {
      await publishTelemetry(tenantId, device.id, [{ sensor: 'water_level', value: 1.5 }]);
      await sleep(300);
      const rows = await api(admin, 'GET', `/api/telemetry/measurements?device_id=${device.id}`);
      return rows.length > 0;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'the new device to be known to telemetry-service' },
  );
  return { tenantId, id: device.id as string, serial, name: device.name as string };
}

// --- NATS ---------------------------------------------------------------------------

let nats: NatsConnection | undefined;

export async function natsConnection(): Promise<NatsConnection> {
  nats ??= await connect({ servers: `nats://127.0.0.1:${config.env.NATS_HOST_PORT ?? 4222}`, name: 'titan-tests' });
  return nats;
}

/** Publishes raw bytes to an event subject, optionally with an explicit JetStream message id. */
export async function publishRawEvent(eventType: string, data: string, msgId?: string): Promise<void> {
  const js = jetstream(await natsConnection());
  const h = headers();
  await js.publish(`titan.events.${eventType}`, data, { msgID: msgId ?? randomUUID(), headers: h });
}

export async function streamMessageCount(stream: string): Promise<number> {
  const jsm = await jetstreamManager(await natsConnection());
  return (await jsm.streams.info(stream)).state.messages;
}

/** Rebuilds the original event envelope from its audit record. */
export function envelopeFromAudit(record: any, tenantId: string) {
  return {
    event_id: record.event_id,
    event_type: record.event_type,
    schema_version: Number(/\.v(\d+)$/.exec(record.event_type)![1]),
    producer: record.producer,
    aggregate_type: record.aggregate_type,
    aggregate_id: record.aggregate_id,
    tenant_id: tenantId,
    occurred_at: new Date(record.occurred_at).toISOString(),
    correlation_id: record.correlation_id,
    causation_id: record.causation_id,
    actor: record.actor_id ? { id: record.actor_id, username: record.actor_username ?? undefined, type: record.actor_type ?? 'service' } : null,
    payload: record.payload,
  };
}

export async function closeConnections(): Promise<void> {
  await mqttClient?.endAsync().catch(() => undefined);
  mqttClient = undefined;
  await nats?.close().catch(() => undefined);
  nats = undefined;
}

// --- government workflow helpers --------------------------------------------------

export const PERMIT_DATA = {
  applicant_name: 'Alice Applicant',
  site_address: '12 Synthetic Street, Riverbend',
  project_type: 'residential',
  floor_area_m2: 140,
  estimated_cost: 250000,
  start_date: '2027-03-01',
  declaration: true,
};

export async function createAndSubmitCase(applicant: string, formKey: string, data: Record<string, unknown>, title = `Test application ${unique()}`) {
  const draft = await api(applicant, 'POST', '/api/case/cases', { form_key: formKey, title, data });
  await api(applicant, 'POST', `/api/case/cases/${draft.id}/submit`);
  return draft as { id: string; reference_no: string; title: string };
}

/** Waits for a pending task of `stageKey` on the case and returns it. */
export async function pendingTask(reviewer: string, caseId: string, stageKey: string, role?: string) {
  return waitFor(
    async () => {
      const tasks = await api(reviewer, 'GET', `/api/workflow/tasks?subject_id=${caseId}`);
      return tasks.find((t: any) => t.stage_key === stageKey && (!role || t.role === role)) ?? null;
    },
    { timeoutMs: 20_000, intervalMs: 250, what: `a pending '${stageKey}' task for ${reviewer}` },
  );
}

export async function decide(reviewer: string, caseId: string, stageKey: string, decision: 'approve' | 'reject' | 'return', comment?: string) {
  const task = await pendingTask(reviewer, caseId, stageKey);
  return api(reviewer, 'POST', `/api/workflow/tasks/${task.id}/decision`, { decision, comment });
}

export async function caseStatus(user: string, caseId: string, expected: string) {
  return waitFor(
    async () => {
      const c = await api(user, 'GET', `/api/case/cases/${caseId}`);
      return c.status === expected ? c : null;
    },
    { timeoutMs: 20_000, intervalMs: 250, what: `case to become '${expected}'` },
  );
}
