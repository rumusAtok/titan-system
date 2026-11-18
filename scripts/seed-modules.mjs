// Synthetic demonstration data for the modules added after v3: documents, zones,
// procurement and stores, reports, integrations and cameras. Used by scripts/seed.mjs.
// Everything is fictional: supplier names, stream hosts (.example.test, a reserved
// test domain), document texts and amounts. Writes only through the public API and is
// safe to run repeatedly (existing records are left alone).
import { api, rawApi } from './lib/titan-client.mjs';

/** A rectangle as a GeoJSON polygon ([lon, lat] order), closed. */
function box(south, west, north, east) {
  return { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

const text = (s) => Buffer.from(s, 'utf8').toString('base64');
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const MODULES = {
  riverbend: {
    admin: 'adam.admin',
    origin: [3.07, 101.52],
    zones: [
      {
        code: 'RB-FZ-01', name: 'North Bank flood zone', zone_type: 'flood_zone', watch_incidents: true, notify_role: 'incident_commander',
        description: 'Synthetic flood zone along the north bank: pump station 1 and the upper river gauge.', geometry: box(3.075, 101.505, 3.095, 101.53),
      },
      {
        code: 'RB-CA-01', name: 'Market Quarter catchment', zone_type: 'catchment', watch_incidents: true, notify_role: 'duty_officer',
        description: 'Synthetic catchment draining to the Market Quarter pump station and the Old Bridge gate.', geometry: box(3.06, 101.528, 3.08, 101.55),
      },
    ],
    documents: [
      {
        title: 'Pump station operating instructions', document_type: 'procedure', classification: 'internal', retention_class: 'regulatory-7y', requires_review: true,
        links: [{ subject_type: 'asset', code: 'RB-PS-01' }, { subject_type: 'asset', code: 'RB-PS-02' }],
        filename: 'pump-station-operating-instructions.txt',
        body: 'SYNTHETIC DEMONSTRATION DOCUMENT\n\nPump stations are operated by authorised staff on site only. Before starting a pump, check the sump level, the intake screen and the discharge valve position. TITAN records readings and work; it never operates equipment.\n',
      },
      {
        title: 'Old Bridge flood gate inspection report (Q3)', document_type: 'inspection_report', classification: 'internal', retention_class: 'operational-3y', requires_review: false,
        links: [{ subject_type: 'asset', code: 'RB-FG-01' }],
        filename: 'old-bridge-gate-inspection-q3.txt',
        body: 'SYNTHETIC DEMONSTRATION DOCUMENT\n\nVisual inspection of the gate leaf, seals and hoist. Minor corrosion on the upstream guide rail; schedule repainting. No leakage observed at the bottom seal.\n',
      },
      {
        title: 'Flood response contact roster', document_type: 'record', classification: 'restricted', allowed_roles: ['incident_commander'], retention_class: 'transitory', requires_review: false,
        links: [],
        filename: 'contact-roster.csv',
        content_type: 'text/csv',
        body: 'role,shift,call sign\nincident commander,day,RIVER-1\nincident commander,night,RIVER-2\n',
      },
    ],
    suppliers: [
      { code: 'SYN-PUMPS', name: 'Synthetic Pump Spares Co', contact_email: 'orders@pumps.example.test', phone: null },
      { code: 'SYN-ELEC', name: 'Synthetic Electrical Supplies', contact_email: null, phone: null },
    ],
    items: [
      { sku: 'PS-SEAL-KIT', name: 'Pump mechanical seal kit', category: 'pump spares', unit: 'kit', unit_cost: 420, currency: 'USD', reorder_level: 2, reorder_quantity: 4, preferred_supplier_code: 'SYN-PUMPS' },
      { sku: 'FLOAT-SW', name: 'Sump float switch', category: 'pump spares', unit: 'each', unit_cost: 85.5, currency: 'USD', reorder_level: 3, reorder_quantity: 6, preferred_supplier_code: 'SYN-PUMPS' },
      { sku: 'BATT-12V', name: '12 V sensor battery pack', category: 'telemetry', unit: 'each', unit_cost: 64, currency: 'USD', reorder_level: 4, reorder_quantity: 10, preferred_supplier_code: 'SYN-ELEC' },
      { sku: 'SANDBAG', name: 'Sandbag (filled)', category: 'flood defence', unit: 'each', unit_cost: 3.2, currency: 'USD', reorder_level: 200, reorder_quantity: 500, preferred_supplier_code: null },
    ],
    stock: [
      ['PS-SEAL-KIT', 'MAIN-DEPOT', 3], ['FLOAT-SW', 'MAIN-DEPOT', 8], ['BATT-12V', 'MAIN-DEPOT', 6], ['BATT-12V', 'FIELD-VAN-1', 2], ['SANDBAG', 'MAIN-DEPOT', 1200],
    ],
    purchase: { as: 'sid.stores', title: 'Spare float switches for the monsoon season', supplier_code: 'SYN-PUMPS', delivery_location: 'MAIN-DEPOT', lines: [{ sku: 'FLOAT-SW', quantity: 6 }] },
    reports: [
      {
        name: 'Weekly operations summary', description: 'Incidents, waiting work and asset condition for the weekly operations meeting (synthetic data).', schedule: 'weekly', notify_role: 'incident_commander',
        sections: [
          { title: 'Incidents by severity and status', dataset: 'incidents_by_severity' },
          { title: 'Work waiting by stage', dataset: 'pending_tasks' },
          { title: 'Assets by status and condition', dataset: 'asset_maintenance_status' },
        ],
      },
    ],
    endpoint: { name: 'Regional weather service alerts', default_severity: 'warning', default_category: null },
    subscription: { name: 'Local test receiver', target_url: 'http://webhook-sink:8080/riverbend', event_types: ['incident.created.v1', 'procurement.stock.low.v1', 'video.marker.created.v1'] },
    cameras: [
      { code: 'RB-CAM-01', name: 'Old Bridge flood gate camera', asset: 'RB-FG-01', offset: [-0.006, 0.011], location_note: 'Mounted on the gate control kiosk, facing upstream', stream_url: 'http://localhost:8888/cam-a/index.m3u8', online: true },
      { code: 'RB-CAM-02', name: 'Market Quarter pump station camera', asset: 'RB-PS-02', offset: [0.004, 0.019], location_note: 'Station yard', stream_url: 'http://localhost:8888/cam-b/index.m3u8', online: true },
      { code: 'RB-CAM-03', name: 'Eastside channel camera', asset: 'RB-DR-07', offset: [-0.014, 0.027], location_note: 'Footbridge, awaiting power', stream_url: null, online: false },
    ],
  },
  meridian: {
    admin: 'maya.admin',
    origin: [1.47, 103.76],
    zones: [
      {
        code: 'MER-P1-SITE', name: 'Plant 1 site boundary', zone_type: 'site_boundary', watch_incidents: true, notify_role: 'production_supervisor',
        description: 'Synthetic boundary of Meridian Plant 1.', geometry: box(1.4695, 103.7595, 1.4712, 103.7612),
      },
      {
        code: 'MER-HQ-AREA', name: 'Head office grounds', zone_type: 'service_area', watch_incidents: true, notify_role: 'facility_manager',
        description: 'Synthetic service area of the head office building.', geometry: box(1.4895, 103.7745, 1.4905, 103.7755),
      },
    ],
    documents: [
      {
        title: 'CNC machining centre maintenance manual', document_type: 'manual', classification: 'internal', retention_class: 'permanent', requires_review: true,
        links: [{ subject_type: 'asset', code: 'MER-CNC-01' }, { subject_type: 'asset', code: 'MER-CNC-02' }],
        filename: 'vmc-850-maintenance-manual.txt',
        body: 'SYNTHETIC DEMONSTRATION DOCUMENT\n\nDaily: check way lube level and coolant concentration. Weekly: clean chip conveyor. Every 2000 hours: inspect spindle bearings (part BRG-6205) and replace if vibration exceeds the warning level.\n',
      },
      {
        title: 'Rooftop HVAC service contract', document_type: 'contract', classification: 'restricted', allowed_roles: ['facility_manager', 'procurement_officer'], retention_class: 'regulatory-7y', requires_review: false,
        links: [{ subject_type: 'asset', code: 'MER-HVAC-01' }],
        filename: 'hvac-service-contract.txt',
        body: 'SYNTHETIC DEMONSTRATION DOCUMENT\n\nQuarterly preventive maintenance of the rooftop unit; filter replacement every visit; response within 8 hours for breakdowns. Fictional contract for demonstration only.\n',
      },
    ],
    suppliers: [
      { code: 'SYN-BEAR', name: 'Synthetic Bearings Ltd', contact_email: 'sales@bearings.example.test', phone: null },
      { code: 'SYN-HVAC', name: 'Synthetic Climate Parts', contact_email: null, phone: null },
      { code: 'SYN-BELT', name: 'Synthetic Conveyor Components', contact_email: null, phone: null },
    ],
    items: [
      { sku: 'BRG-6205', name: 'Spindle bearing 6205', category: 'machine spares', unit: 'each', unit_cost: 38.75, currency: 'USD', reorder_level: 4, reorder_quantity: 10, preferred_supplier_code: 'SYN-BEAR' },
      { sku: 'FLT-HVAC-24', name: 'HVAC filter 24 in', category: 'facility spares', unit: 'each', unit_cost: 22, currency: 'USD', reorder_level: 6, reorder_quantity: 12, preferred_supplier_code: 'SYN-HVAC' },
      { sku: 'BELT-CONV-18', name: 'Modular conveyor belt section', category: 'machine spares', unit: 'm', unit_cost: 310, currency: 'USD', reorder_level: 2, reorder_quantity: 6, preferred_supplier_code: 'SYN-BELT' },
      { sku: 'COOLANT-20L', name: 'Machining coolant concentrate 20 L', category: 'consumables', unit: 'drum', unit_cost: 145, currency: 'USD', reorder_level: 3, reorder_quantity: 8, preferred_supplier_code: null },
    ],
    stock: [
      ['BRG-6205', 'MAIN-STORE', 6], ['FLT-HVAC-24', 'MAIN-STORE', 10], ['FLT-HVAC-24', 'HQ-STORE', 4], ['BELT-CONV-18', 'MAIN-STORE', 3], ['COOLANT-20L', 'MAIN-STORE', 5],
    ],
    purchase: { as: 'stan.stores', title: 'Conveyor belt sections for the Line A rebuild', supplier_code: 'SYN-BELT', delivery_location: 'MAIN-STORE', lines: [{ sku: 'BELT-CONV-18', quantity: 18 }] },
    reports: [
      {
        name: 'Monthly maintenance performance', description: 'Work orders and turnaround per pack and request type (synthetic data).', schedule: 'monthly', notify_role: 'maintenance_planner',
        sections: [
          { title: 'Work orders by status', dataset: 'maintenance_work_orders' },
          { title: 'Turnaround of completed work', dataset: 'work_order_turnaround' },
          { title: 'Requests by type and status', dataset: 'maintenance_requests' },
        ],
      },
    ],
    endpoint: { name: 'Building management system alarms', default_severity: 'warning', default_category: null },
    subscription: { name: 'Local test receiver', target_url: 'http://webhook-sink:8080/meridian', event_types: ['maintenance.work_order.completed.v1', 'procurement.purchase_order.issued.v1', 'procurement.stock.low.v1'] },
    cameras: [
      { code: 'MER-CAM-01', name: 'Machining line A overview', asset: 'MER-LINE-A', offset: [0.0005, 0.0004], location_note: 'Mezzanine, facing the line', stream_url: 'http://localhost:8888/cam-a/index.m3u8', online: true },
      { code: 'MER-CAM-02', name: 'Head office lobby', asset: 'MER-HQ', offset: [0.02, 0.015], location_note: 'Reception', stream_url: 'http://localhost:8888/cam-b/index.m3u8', online: true, privacy_masking: true },
    ],
  },
};

async function available(user, path) {
  const res = await rawApi(user, 'GET', path);
  return res.status === 200 ? res.body : null;
}

export async function seedModules(note) {
  for (const [slug, m] of Object.entries(MODULES)) {
    console.log(`\nModules for ${slug}`);
    const admin = m.admin;
    const assets = Object.fromEntries((await api(admin, 'GET', '/api/asset/assets?limit=500')).map((a) => [a.code, a]));

    // Zones (geospatial, core).
    const zones = await available(admin, '/api/geo/zones');
    if (!zones) console.log('  (geospatial-service not available: zones skipped)');
    else for (const z of m.zones) {
      if (zones.some((e) => e.code === z.code)) continue;
      await api(admin, 'POST', '/api/geo/zones', z);
      note(`zone ${z.code}`);
    }

    // Documents (core). Created by the administrator; reviewed documents wait for the records manager.
    const docs = await available(admin, '/api/document/documents?limit=500');
    if (!docs) console.log('  (document-service not available: documents skipped)');
    else for (const d of m.documents) {
      if (docs.some((e) => e.title === d.title)) continue;
      const created = await api(admin, 'POST', '/api/document/documents', {
        title: d.title,
        description: 'Synthetic demonstration document.',
        document_type: d.document_type,
        classification: d.classification,
        allowed_roles: d.allowed_roles ?? [],
        retention_class: d.retention_class,
        requires_review: d.requires_review,
        links: d.links.filter((l) => assets[l.code]).map((l) => ({ subject_type: l.subject_type, subject_id: assets[l.code].id })),
        filename: d.filename,
        content_type: d.content_type ?? 'text/plain',
        content_base64: text(d.body),
        change_note: 'Initial version',
      });
      await api(admin, 'POST', `/api/document/documents/${created.id}/versions/1/submit`);
      note(`document "${d.title}" (${d.requires_review ? 'in review' : 'published'})`);
    }

    // Procurement and stores.
    const suppliers = await available(admin, '/api/procurement/suppliers');
    if (!suppliers) console.log('  (procurement capability or service not available: stores skipped)');
    else {
      for (const s of m.suppliers) {
        if (suppliers.some((e) => e.code === s.code)) continue;
        await api(admin, 'POST', '/api/procurement/suppliers', s);
        note(`supplier ${s.code}`);
      }
      const items = await api(admin, 'GET', '/api/procurement/items');
      for (const i of m.items) {
        if (items.some((e) => e.sku === i.sku)) continue;
        await api(admin, 'POST', '/api/procurement/items', i);
        note(`item ${i.sku}`);
      }
      // Opening stock: recorded as a count, only where nothing has ever been counted.
      const levels = await api(admin, 'GET', '/api/procurement/items');
      for (const [sku, location, counted] of m.stock) {
        const item = levels.find((e) => e.sku === sku);
        if (item?.locations.some((l) => l.location === location)) continue;
        await api(admin, 'POST', '/api/procurement/stock/adjust', { sku, location, counted, note: 'Opening stock count (synthetic)' });
        note(`stock ${sku} at ${location}: ${counted}`);
      }
      const requests = await api(admin, 'GET', '/api/procurement/purchase-requests');
      if (!requests.some((r) => r.title === m.purchase.title)) {
        const pr = await api(m.purchase.as, 'POST', '/api/procurement/purchase-requests', { ...m.purchase, as: undefined, justification: 'Synthetic demonstration request.' });
        note(`purchase request ${pr.reference_no} (${pr.total_amount} ${pr.currency}, awaiting approval)`);
      }
    }

    // Reports (needs the analytics profile for the dataset registry).
    const definitions = await available(admin, '/api/report/definitions');
    if (!definitions) console.log('  (reporting capability or service not available: reports skipped)');
    else for (const r of m.reports) {
      if (definitions.some((e) => e.name === r.name)) continue;
      const res = await rawApi(admin, 'POST', '/api/report/definitions', r);
      if (res.status === 503) {
        console.log('  (analytics profile not running: report definitions skipped)');
        break;
      }
      if (res.status !== 201) throw new Error(`report ${r.name}: ${res.status} ${JSON.stringify(res.body)}`);
      note(`report "${r.name}"`);
    }

    // Integrations: one inbound endpoint and one subscription to the local test receiver.
    const endpoints = await available(admin, '/api/integration/endpoints');
    if (!endpoints) console.log('  (integrations capability or service not available: integrations skipped)');
    else {
      if (!endpoints.some((e) => e.name === m.endpoint.name)) {
        const e = await api(admin, 'POST', '/api/integration/endpoints', m.endpoint);
        // Development only: the secret is displayed once. Rotate it from the Integrations page when needed.
        note(`inbound endpoint "${e.name}" at ${e.path} (secret shown once, local development only: ${e.secret})`);
      }
      const subs = await api(admin, 'GET', '/api/integration/subscriptions');
      if (!subs.some((s) => s.name === m.subscription.name)) {
        await api(admin, 'POST', '/api/integration/subscriptions', m.subscription);
        note(`subscription "${m.subscription.name}" -> ${m.subscription.target_url}`);
      }
    }

    // Cameras: register, bring online, and record one synthetic recording reference each.
    const cameras = await available(admin, '/api/video/cameras');
    if (!cameras) console.log('  (video capability or service not available: cameras skipped)');
    else for (const c of m.cameras) {
      const existing = cameras.find((e) => e.code === c.code);
      if (existing) {
        // Seeded cameras nobody has changed since (registered, then brought online: version 2) are
        // pointed at the local video test server, which plays a synthetic test pattern.
        if (c.stream_url && existing.version === 2 && existing.status === 'online') {
          await api(admin, 'PATCH', `/api/video/cameras/${existing.id}`, { stream_url: c.stream_url, expected_version: 2 });
          note(`camera ${c.code} now streams from the local video test server`);
        }
        continue;
      }
      const camera = await api(admin, 'POST', '/api/video/cameras', {
        code: c.code,
        name: c.name,
        location_note: c.location_note,
        asset_id: assets[c.asset]?.id ?? null,
        latitude: m.origin[0] + c.offset[0],
        longitude: m.origin[1] + c.offset[1],
        stream_url: c.stream_url,
        retention_days: 30,
        privacy_masking: c.privacy_masking ?? false,
      });
      if (c.online) {
        await api(admin, 'POST', `/api/video/cameras/${camera.id}/status`, { status: 'online', note: 'Commissioned (synthetic)' });
        await api(admin, 'POST', `/api/video/cameras/${camera.id}/recordings`, { started_at: hoursAgo(26), ended_at: hoursAgo(25), storage_ref: `vms://${c.code.toLowerCase()}/segment-demo`, size_bytes: 734_003_200 });
      }
      note(`camera ${c.code}${c.online ? ' (online, 1 recording reference)' : ''}`);
    }
  }
}
