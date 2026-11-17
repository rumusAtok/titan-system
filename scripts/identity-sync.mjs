// Adds missing realm roles and SYNTHETIC demo users to a Keycloak that already
// has the `titan` realm (Keycloak imports the realm file only into an empty
// database, so an existing installation does not pick up later additions).
//
//   node scripts/identity-sync.mjs
//
// Additive only: it creates what is missing and grants missing roles to the
// demo users it knows. It never deletes or changes a password of an existing
// user. Development and test installations only; it uses the Keycloak
// bootstrap administrator from .env.
import { roles, users } from '../infrastructure/docker/keycloak/identity-data.mjs';
import { config } from './lib/titan-client.mjs';

const REALM = 'titan';
const base = config.keycloakUrl;
const env = config.env;

async function adminToken() {
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: env.KEYCLOAK_ADMIN ?? 'admin', password: env.KEYCLOAK_ADMIN_PASSWORD ?? '' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`could not sign in to Keycloak as the bootstrap administrator: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token;
}

const token = await adminToken();

async function kc(method, path, body) {
  const res = await fetch(`${base}/admin/realms/${REALM}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let created = 0;
const note = (what) => {
  created += 1;
  console.log(`  + ${what}`);
};

console.log(`Synchronising demo identities with ${base} (realm ${REALM})...`);

const existingRoles = new Map((await kc('GET', '/roles?max=500')).body.map((r) => [r.name, r]));
for (const [name, description] of Object.entries(roles)) {
  if (existingRoles.has(name)) continue;
  await kc('POST', '/roles', { name, description });
  existingRoles.set(name, (await kc('GET', `/roles/${encodeURIComponent(name)}`)).body);
  note(`role ${name}`);
}

for (const [username, firstName, lastName, tenant, department, realmRoles] of users) {
  let [user] = (await kc('GET', `/users?username=${encodeURIComponent(username)}&exact=true`)).body;
  if (!user) {
    await kc('POST', '/users', {
      username,
      enabled: true,
      emailVerified: true,
      firstName,
      lastName,
      email: `${username}@titan.example`,
      attributes: { tenant_id: [tenant], ...(department ? { department: [department] } : {}) },
      credentials: [{ type: 'password', value: config.demoPassword, temporary: false }],
    });
    [user] = (await kc('GET', `/users?username=${encodeURIComponent(username)}&exact=true`)).body;
    note(`user ${username}`);
  }
  const held = new Set((await kc('GET', `/users/${user.id}/role-mappings/realm`)).body.map((r) => r.name));
  const missing = realmRoles.filter((r) => !held.has(r)).map((r) => ({ id: existingRoles.get(r).id, name: r }));
  if (missing.length) {
    await kc('POST', `/users/${user.id}/role-mappings/realm`, missing);
    note(`roles ${missing.map((m) => m.name).join(', ')} for ${username}`);
  }
}

console.log(`Identity sync complete: ${created} change(s)${created === 0 ? ' (everything already existed)' : ''}.`);
