// Universal core modules added after v3, on the real stack (tenant Riverbend):
//   documents: upload + scan -> review workflow -> published version, classification, legal hold, disposal
//   geospatial: zones, point and radius queries, incidents located in a watched zone
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { api, closeConnections, config, decideSubject, rawApi, tokenFor, unique, waitFor } from '../helpers/stack.ts';

const ADMIN = 'adam.admin';
const AUTHOR = 'amy.assets'; // asset manager: staff, not a records manager
const RECORDS = 'rex.records';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function newDoc(extra: Record<string, unknown> = {}) {
  return {
    title: `Test procedure ${unique()}`,
    document_type: 'procedure',
    classification: 'internal',
    retention_class: 'operational-3y',
    requires_review: true,
    filename: 'procedure.txt',
    content_type: 'text/plain',
    content_base64: b64('Synthetic test document.\n'),
    ...extra,
  };
}

async function documentState(user: string, id: string, ok: (d: any) => boolean, what: string) {
  return waitFor(async () => {
    const d = await api(user, 'GET', `/api/document/documents/${id}`);
    return ok(d) ? d : null;
  }, { what });
}

after(closeConnections);

describe('Controlled documents', () => {
  it('a reviewed version is published by the records manager through the workflow engine', async () => {
    const doc = await api(AUTHOR, 'POST', '/api/document/documents', newDoc());
    assert.ok(doc.reference_no.startsWith('DOC-'));
    assert.equal(doc.versions[0].status, 'draft');
    await api(AUTHOR, 'POST', `/api/document/documents/${doc.id}/versions/1/submit`);
    const versionId = doc.versions[0].id;
    // The review task names the version; the page can find the document from it.
    assert.deepEqual(await api(RECORDS, 'GET', `/api/document/versions/${versionId}`), { document_id: doc.id, version: 1 });
    await decideSubject(RECORDS, versionId, 'records_review', 'approve');
    const published = await documentState(AUTHOR, doc.id, (d) => d.versions[0].status === 'published', 'the version to be published');
    assert.equal(published.current_version_id, versionId);
    assert.ok(published.retain_until, 'retention starts when a version is published');
  });

  it('a rejected review leaves the document unpublished', async () => {
    const doc = await api(AUTHOR, 'POST', '/api/document/documents', newDoc());
    await api(AUTHOR, 'POST', `/api/document/documents/${doc.id}/versions/1/submit`);
    await decideSubject(RECORDS, doc.versions[0].id, 'records_review', 'reject', 'Wrong template');
    const d = await documentState(AUTHOR, doc.id, (x) => x.versions[0].status === 'rejected', 'the version to be rejected');
    assert.equal(d.current_version_id, null);
  });

  it('refuses malware (EICAR test string) and content that does not match its declared type', async () => {
    const eicar = await rawApi(AUTHOR, 'POST', '/api/document/documents', newDoc({ content_base64: b64(EICAR) }));
    assert.equal(eicar.status, 400);
    assert.match(eicar.body.error.message, /EICAR/);
    const fakePdf = await rawApi(AUTHOR, 'POST', '/api/document/documents', newDoc({ filename: 'x.pdf', content_type: 'application/pdf' }));
    assert.equal(fakePdf.status, 400);
    const exe = await rawApi(AUTHOR, 'POST', '/api/document/documents', newDoc({ filename: 'x.exe', content_type: 'application/x-msdownload' }));
    assert.equal(exe.status, 400);
  });

  it('a download is an attachment with the checksum of its content; drafts are only for their author and records', async () => {
    const content = `Checksum test ${unique()}\n`;
    const doc = await api(AUTHOR, 'POST', '/api/document/documents', newDoc({ content_base64: b64(content), requires_review: false }));
    const res = await fetch(`${config.gatewayUrl}/api/document/documents/${doc.id}/versions/1/content`, { headers: { authorization: `Bearer ${await tokenFor(AUTHOR)}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-content-sha256'), createHash('sha256').update(content).digest('hex'));
    assert.equal(await res.text(), content);
    assert.equal((await rawApi('derek.duty', 'GET', `/api/document/documents/${doc.id}/versions/1/content`)).status, 404, 'a draft is not shown to other staff');
    // Without review only a records role may publish.
    assert.equal((await rawApi(AUTHOR, 'POST', `/api/document/documents/${doc.id}/versions/1/submit`)).status, 403);
    await api(RECORDS, 'POST', `/api/document/documents/${doc.id}/versions/1/submit`);
    assert.equal((await rawApi('derek.duty', 'GET', `/api/document/documents/${doc.id}/versions/1/content`)).status, 200, 'published internal content is for all staff');
  });

  it('a restricted document exists only for its allowed roles', async () => {
    const doc = await api(ADMIN, 'POST', '/api/document/documents', newDoc({ classification: 'restricted', allowed_roles: ['incident_commander'], requires_review: false }));
    assert.equal((await rawApi('irene.commander', 'GET', `/api/document/documents/${doc.id}`)).status, 200);
    assert.equal((await rawApi('derek.duty', 'GET', `/api/document/documents/${doc.id}`)).status, 404);
    assert.ok(!(await api('derek.duty', 'GET', '/api/document/documents?limit=500')).some((d: any) => d.id === doc.id), 'not even listed');
    assert.equal((await rawApi('maya.admin', 'GET', `/api/document/documents/${doc.id}`)).status, 404, 'another tenant');
  });

  it('a legal hold blocks disposal; disposal removes the content and keeps the record', async () => {
    const doc = await api(ADMIN, 'POST', '/api/document/documents', newDoc({ retention_class: 'transitory', requires_review: false }));
    await api(RECORDS, 'POST', `/api/document/documents/${doc.id}/versions/1/submit`);
    assert.equal((await rawApi(AUTHOR, 'POST', `/api/document/documents/${doc.id}/legal-hold`, { legal_hold: true, reason: 'Claim' })).status, 403);
    await api(RECORDS, 'POST', `/api/document/documents/${doc.id}/legal-hold`, { legal_hold: true, reason: 'Insurance claim pending' });
    const blocked = await rawApi(RECORDS, 'POST', `/api/document/documents/${doc.id}/dispose`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'disposal_blocked_legal_hold');
    await api(RECORDS, 'POST', `/api/document/documents/${doc.id}/legal-hold`, { legal_hold: false, reason: 'Claim settled' });
    await api(RECORDS, 'POST', `/api/document/documents/${doc.id}/dispose`);
    const d = await api(RECORDS, 'GET', `/api/document/documents/${doc.id}`);
    assert.equal(d.status, 'disposed');
    assert.equal((await rawApi(RECORDS, 'GET', `/api/document/documents/${doc.id}/versions/1/content`)).status, 410);
    assert.ok(d.events.some((e: any) => /dispos/i.test(e.message)));
  });

  it('a document of longer retention cannot be disposed of early', async () => {
    const doc = await api(ADMIN, 'POST', '/api/document/documents', newDoc({ retention_class: 'regulatory-7y', requires_review: false }));
    await api(RECORDS, 'POST', `/api/document/documents/${doc.id}/versions/1/submit`);
    const res = await rawApi(RECORDS, 'POST', `/api/document/documents/${doc.id}/dispose`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'disposal_blocked_retention_not_expired');
  });
});

describe('Zones and locations', () => {
  let pump: any;
  before(async () => {
    pump = (await api(ADMIN, 'GET', '/api/asset/assets?limit=500')).find((a: any) => a.code === 'RB-PS-01');
    assert.ok(pump, 'seeded asset RB-PS-01 (run `npm run seed`)');
  });

  it('knows where the seeded assets are and which zone a point is in', async () => {
    const zones = await api(ADMIN, 'GET', `/api/geo/locate?lat=${pump.latitude}&lon=${pump.longitude}`);
    assert.deepEqual(zones.zones.map((z: any) => z.code), ['RB-FZ-01']);
    const near = await waitFor(async () => {
      const n = await api(ADMIN, 'GET', `/api/geo/nearby?lat=${pump.latitude}&lon=${pump.longitude}&radius_m=200&feature_type=asset`);
      return n.some((f: any) => f.code === 'RB-PS-01') ? n : null;
    }, { what: 'the pump station to be known to geospatial-service' });
    assert.ok(near.every((f: any) => f.distance_m <= 200));
  });

  it('validates geometry and who may draw zones', async () => {
    const open = { type: 'Polygon', coordinates: [[[101.5, 3.0], [101.6, 3.0], [101.6, 3.1]]] };
    assert.equal((await rawApi(ADMIN, 'POST', '/api/geo/zones', { code: `T${unique()}`.slice(0, 30), name: 'Bad', zone_type: 'other', geometry: open })).status, 400);
    const ok = { type: 'Polygon', coordinates: [[[101.5, 3.0], [101.6, 3.0], [101.6, 3.1], [101.5, 3.0]]] };
    assert.equal((await rawApi('derek.duty', 'POST', '/api/geo/zones', { code: `T${unique()}`.slice(0, 30), name: 'Not allowed', zone_type: 'other', geometry: ok })).status, 403);
  });

  it('an incident at an asset inside a watched zone is located there and noted on the incident', async () => {
    const incident = await api('derek.duty', 'POST', '/api/incident/incidents', { title: `Test pump fault ${unique()}`, severity: 'warning', asset_id: pump.id });
    const located = await waitFor(async () => (await api(ADMIN, 'GET', '/api/geo/incidents')).find((i: any) => i.incident_id === incident.id) ?? null, { what: 'the incident to be located' });
    assert.equal(located.located_via, 'asset');
    assert.deepEqual(located.zones.map((z: any) => z.code), ['RB-FZ-01']);
    await waitFor(async () => (await api(ADMIN, 'GET', `/api/incident/incidents/${incident.id}`)).timeline.some((t: any) => t.entry_type === 'location' && t.message.includes('RB-FZ-01')), {
      what: 'the incident timeline to record the zone',
    });
  });

  it('layers are the tenant\'s own', async () => {
    const mine = await api(ADMIN, 'GET', '/api/geo/layers');
    assert.ok(mine.features.some((f: any) => f.properties.code === 'RB-FZ-01'));
    const theirs = await api('maya.admin', 'GET', '/api/geo/layers');
    assert.ok(!theirs.features.some((f: any) => String(f.properties.code).startsWith('RB-')));
  });
});
