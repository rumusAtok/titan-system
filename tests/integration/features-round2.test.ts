// Features added in the second round after v3, on the real stack:
// document full-text search, geospatial backfill, report PDF and Excel output, camera update
// (local test stream), and e-mail delivered to the local mail catcher only.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { api, closeConnections, config, rawApi, tokenFor, unique, waitFor } from '../helpers/stack.ts';

const ADMIN = 'adam.admin';
const RECORDS = 'rex.records';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

async function download(user: string, path: string) {
  const res = await fetch(`${config.gatewayUrl}${path}`, { headers: { authorization: `Bearer ${await tokenFor(user)}` } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), body: Buffer.from(await res.arrayBuffer()) };
}

after(closeConnections);

describe('Document full-text search', () => {
  it('finds published text, ranks it, and does not search drafts or disposed content', async () => {
    const word = `zephyrine${unique().toLowerCase()}`;
    const published = await api(ADMIN, 'POST', '/api/document/documents', {
      title: `Seal replacement note ${unique()}`, document_type: 'procedure', retention_class: 'transitory', requires_review: false,
      filename: 'note.txt', content_type: 'text/plain', content_base64: b64(`Replace the ${word} gasket before restarting the pump.`),
    });
    await api(RECORDS, 'POST', `/api/document/documents/${published.id}/versions/1/submit`);
    const draft = await api(ADMIN, 'POST', '/api/document/documents', {
      title: `Unpublished note ${unique()}`, document_type: 'procedure', requires_review: true,
      filename: 'draft.txt', content_type: 'text/plain', content_base64: b64(`Draft mentions ${word} too.`),
    });
    const hits = await api('derek.duty', 'GET', `/api/document/documents?text=${word}`);
    assert.deepEqual(hits.map((d: any) => d.id), [published.id], 'only the published document matches');
    assert.match(hits[0].snippet, new RegExp(`«${word}»`));
    assert.ok(!hits.some((d: any) => d.id === draft.id));
    await api(RECORDS, 'POST', `/api/document/documents/${published.id}/dispose`);
    assert.deepEqual(await api('derek.duty', 'GET', `/api/document/documents?text=${word}`), [], 'disposed content is no longer searchable');
    assert.equal((await rawApi('maya.admin', 'GET', `/api/document/documents?text=${word}`)).body.length, 0, 'another tenant');
  });
});

describe('Geospatial backfill', () => {
  it('refreshes located assets, devices and cameras with the caller\'s own access', async () => {
    assert.equal((await rawApi('derek.duty', 'POST', '/api/geo/backfill')).status, 403);
    const r = await api(ADMIN, 'POST', '/api/geo/backfill');
    const assets = (await api(ADMIN, 'GET', '/api/asset/assets?limit=500')).filter((a: any) => a.latitude !== null && a.status !== 'retired');
    assert.equal(r.assets, assets.length);
    assert.equal(r.sources.devices, true);
    assert.equal(r.sources.cameras, true);
    const layers = await api(ADMIN, 'GET', '/api/geo/layers');
    for (const a of assets) assert.ok(layers.features.some((f: any) => f.properties.id === a.id), `asset ${a.code} is on the map`);
  });
});

describe('Report output formats', () => {
  it('a run can be downloaded as PDF and as an Excel workbook', async () => {
    const def = (await api('anna.analyst', 'GET', '/api/report/definitions')).find((d: any) => d.name === 'Weekly operations summary');
    assert.ok(def, 'seeded report exists (run `npm run seed`)');
    const run = await api('anna.analyst', 'POST', `/api/report/definitions/${def.id}/generate`);
    const pdf = await download('derek.duty', `/api/report/runs/${run.id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.match(pdf.disposition ?? '', /^attachment; filename=".+\.pdf"$/);
    assert.equal(pdf.body.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.ok(pdf.body.toString('latin1').includes('Weekly operations summary'));
    const xlsx = await download('derek.duty', `/api/report/runs/${run.id}/xlsx`);
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
    assert.ok(xlsx.body.toString('utf8').includes('xl/worksheets/sheet3.xml'), 'one sheet per section');
    assert.equal((await download('maya.admin', `/api/report/runs/${run.id}/pdf`)).status, 404, 'another tenant');
  });
});

describe('Camera update', () => {
  it('points a camera at a stream, refusing credentials and stale versions', async () => {
    const cam = await api('sara.security', 'POST', '/api/video/cameras', { code: `TCAM-${unique()}`.slice(0, 30), name: 'Update test' });
    assert.equal(cam.has_stream, false);
    assert.equal((await rawApi('sara.security', 'PATCH', `/api/video/cameras/${cam.id}`, { stream_url: 'rtsp://u:p@host/x', expected_version: 1 })).status, 400);
    assert.equal((await rawApi('derek.duty', 'PATCH', `/api/video/cameras/${cam.id}`, { name: 'x y', expected_version: 1 })).status, 403);
    const updated = await api('sara.security', 'PATCH', `/api/video/cameras/${cam.id}`, { stream_url: 'http://localhost:8888/cam-a/index.m3u8', expected_version: 1 });
    assert.equal(updated.has_stream, true);
    assert.equal((await rawApi('sara.security', 'PATCH', `/api/video/cameras/${cam.id}`, { name: 'stale', expected_version: 1 })).status, 409);
  });

  it('the local video test server is serving the synthetic stream the seeded cameras use', async () => {
    const playlist = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${process.env.VIDEO_HOST_PORT ?? 8888}/cam-a/index.m3u8`).catch(() => null);
      return res?.status === 200 ? res.text() : null;
    }, { what: 'the test stream playlist' });
    assert.match(playlist, /^#EXTM3U/);
  });
});
