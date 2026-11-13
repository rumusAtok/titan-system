// Minimal API client shared by the seed script, the sensor simulator and the
// disaster-recovery drill. Uses only Node built-ins.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads KEY=VALUE pairs from the repository .env (does not override the real environment). */
export function loadEnv() {
  const env = { ...process.env };
  for (const name of ['.env', '.env.example']) {
    try {
      const text = readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && env[m[1]] === undefined) env[m[1]] = m[2];
      }
      break;
    } catch {
      // try the next candidate
    }
  }
  return env;
}

const env = loadEnv();

export const config = {
  keycloakUrl: env.TITAN_KEYCLOAK_URL ?? env.KEYCLOAK_PUBLIC_URL ?? 'http://localhost:8081',
  gatewayUrl: env.TITAN_GATEWAY_URL ?? `http://localhost:${env.GATEWAY_HOST_PORT ?? 8080}`,
  mqttUrl: env.TITAN_MQTT_URL ?? `mqtt://localhost:${env.MQTT_HOST_PORT ?? 1883}`,
  mqttUser: env.MQTT_SIMULATOR_USER ?? 'simulator',
  mqttPassword: env.MQTT_SIMULATOR_PASSWORD ?? '',
  demoPassword: env.DEMO_USER_PASSWORD ?? '',
  env,
};

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';

const tokens = new Map();

/** Password-grant token for a synthetic demo user (test-only `titan-cli` client). Cached until shortly before expiry. */
export async function tokenFor(username) {
  const cached = tokens.get(username);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const res = await fetch(`${config.keycloakUrl}/realms/titan/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'titan-cli', username, password: config.demoPassword }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`could not log in as ${username}: ${body.error_description ?? body.error ?? res.status}`);
  tokens.set(username, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

export function claimsOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

export class ApiError extends Error {
  constructor(status, body, method, path) {
    super(`${method} ${path} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/** Calls the gateway as `username`. Returns the parsed body; throws ApiError on a non-2xx status. */
export async function api(username, method, path, body, headers = {}) {
  const res = await rawApi(username, method, path, body, headers);
  if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, res.body, method, path);
  return res.body;
}

/** Like `api` but never throws on HTTP status: returns { status, body, headers }. */
export async function rawApi(username, method, path, body, headers = {}) {
  const auth = username ? { authorization: `Bearer ${await tokenFor(username)}` } : {};
  const res = await fetch(`${config.gatewayUrl}${path}`, {
    method,
    headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}
