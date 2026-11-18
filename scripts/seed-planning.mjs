// Synthetic demonstration data for maintenance planning (preventive plans, inspection plans,
// labour rate) and sourcing (cost centres, budgets, a request for quotation with quotations).
// Used by scripts/seed.mjs. Fictional throughout; written only through the public API;
// safe to run repeatedly.
import { api, rawApi } from './lib/titan-client.mjs';

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const MERIDIAN = {
  admin: 'maya.admin',
  planner: 'paula.planner',
  settings: { labor_rate_per_hour: 52.5, currency: 'USD', parts_store: 'MAIN-STORE' },
  pm: [
    {
      code: 'PM-CNC1-LUBE', name: 'CNC 1 way lubrication and filter check', asset: 'MER-CNC-01', request_type: 'equipment-repair', priority: 'normal',
      interval_days: 30, lead_days: 5, due: 2, estimated_hours: 1.5,
      checklist: ['Top up way lube oil', 'Replace coolant filter', 'Check spindle air purge pressure'],
    },
    {
      code: 'PM-CNC2-BEAR', name: 'CNC 2 spindle bearing inspection', asset: 'MER-CNC-02', request_type: 'equipment-repair', priority: 'high',
      interval_days: 90, lead_days: 7, due: 20, estimated_hours: 4,
      checklist: ['Measure spindle run-out', 'Record bearing temperature at 8000 rpm', 'Replace bearings BRG-6205 if run-out exceeds limit'],
    },
    {
      code: 'PM-HVAC-FILTER', name: 'Rooftop HVAC filter change', asset: 'MER-HVAC-01', request_type: 'facility-service-request', priority: 'normal',
      interval_days: 90, lead_days: 10, due: 6, estimated_hours: 2,
      checklist: ['Replace filters FLT-HVAC-24 (x4)', 'Clean condensate drain', 'Record supply air temperature'],
    },
  ],
  inspections: [
    {
      code: 'INS-LINEA-SAFETY', name: 'Machining line A weekly safety walk', asset: 'MER-LINE-A', location: 'Plant 1, line A', interval_days: 7, due: 0,
      assigned_role: 'production_supervisor', finding_request_type: 'equipment-repair',
      checklist: [
        { key: 'guards', question: 'All machine guards fitted and interlocked', kind: 'pass_fail' },
        { key: 'estops', question: 'Emergency stops tested and working', kind: 'pass_fail' },
        { key: 'walkways', question: 'Walkways clear of chips and coolant', kind: 'pass_fail' },
        { key: 'noise', question: 'Noise level at operator position', kind: 'number', min: 0, max: 85, unit: 'dB(A)' },
      ],
    },
    {
      code: 'INS-HQ-FIRE', name: 'Head office monthly fire safety check', asset: 'MER-HQ', location: 'Head office, all floors', interval_days: 30, due: 0,
      assigned_role: 'facility_manager', finding_request_type: 'inspection-finding',
      checklist: [
        { key: 'extinguishers', question: 'Extinguishers present, sealed and in date', kind: 'pass_fail' },
        { key: 'exits', question: 'Fire exits unobstructed and signs lit', kind: 'pass_fail' },
        { key: 'alarm_panel', question: 'Fire alarm panel shows no faults', kind: 'pass_fail' },
      ],
    },
  ],
  costCentres: [
    { code: 'MAINT', name: 'Maintenance', budget: 60000 },
    { code: 'FAC', name: 'Facilities', budget: 25000 },
    { code: 'PROD', name: 'Production consumables', budget: 4000 },
  ],
  rfq: {
    title: 'Spindle bearings for the 2027 overhaul', delivery_location: 'MAIN-STORE', cost_centre_code: 'MAINT', respond_by: day(10),
    lines: [{ sku: 'BRG-6205', quantity: 40 }, { sku: 'COOLANT-20L', quantity: 10 }],
    supplier_codes: ['SYN-BEAR', 'SYN-BELT'],
    quotes: [
      { supplier_code: 'SYN-BEAR', lines: [{ line_no: 1, unit_cost: 36.9 }, { line_no: 2, unit_cost: 149 }], lead_time_days: 14, note: 'Synthetic quotation' },
      { supplier_code: 'SYN-BELT', lines: [{ line_no: 1, unit_cost: 34.5 }, { line_no: 2, unit_cost: 158 }], lead_time_days: 30, note: 'Synthetic quotation' },
    ],
  },
};

const RIVERBEND = {
  admin: 'adam.admin',
  costCentres: [
    { code: 'OPS-FLOOD', name: 'Flood operations', budget: 15000 },
    { code: 'ENG', name: 'Engineering', budget: 8000 },
  ],
};

async function costCentres(admin, centres, note) {
  const existing = await api(admin, 'GET', '/api/procurement/cost-centres');
  const year = new Date().getUTCFullYear();
  for (const c of centres) {
    const found = existing.find((e) => e.code === c.code);
    if (!found) {
      await api(admin, 'POST', '/api/procurement/cost-centres', { code: c.code, name: c.name });
      note(`cost centre ${c.code}`);
    }
    if (!found || found.budget === null) {
      await api(admin, 'PUT', `/api/procurement/cost-centres/${c.code}/budget`, { year, amount: c.budget, currency: 'USD' });
      note(`budget ${c.code} ${year}: ${c.budget} USD`);
    }
  }
}

export async function seedPlanning(note) {
  console.log('\nMaintenance planning and sourcing');
  const m = MERIDIAN;
  if ((await rawApi(m.admin, 'GET', '/api/maintenance/planning/pm-plans')).status !== 200) {
    console.log('  (maintenance planning not available for Meridian: skipped)');
  } else {
    const assets = Object.fromEntries((await api(m.admin, 'GET', '/api/asset/assets?limit=500')).map((a) => [a.code, a]));
    const settings = await api(m.admin, 'GET', '/api/maintenance/settings');
    if (Number(settings.labor_rate_per_hour) !== m.settings.labor_rate_per_hour) {
      await api(m.admin, 'PUT', '/api/maintenance/settings', m.settings);
      note(`labour rate ${m.settings.labor_rate_per_hour} ${m.settings.currency}/h`);
    }
    const pm = await api(m.planner, 'GET', '/api/maintenance/planning/pm-plans');
    for (const p of m.pm) {
      if (pm.some((e) => e.code === p.code) || !assets[p.asset]) continue;
      await api(m.planner, 'POST', '/api/maintenance/planning/pm-plans', {
        code: p.code, name: p.name, description: 'Synthetic preventive plan.', asset_id: assets[p.asset].id, request_type: p.request_type, priority: p.priority,
        interval_days: p.interval_days, lead_days: p.lead_days, next_due_on: day(p.due), estimated_hours: p.estimated_hours, checklist: p.checklist,
      });
      note(`preventive plan ${p.code} (every ${p.interval_days} days)`);
    }
    const ins = await api(m.planner, 'GET', '/api/maintenance/planning/inspection-plans');
    for (const p of m.inspections) {
      if (ins.some((e) => e.code === p.code)) continue;
      const plan = await api(m.planner, 'POST', '/api/maintenance/planning/inspection-plans', {
        code: p.code, name: p.name, asset_id: assets[p.asset]?.id ?? null, location: p.location, checklist: p.checklist, interval_days: p.interval_days,
        next_due_on: day(p.due), assigned_role: p.assigned_role, finding_request_type: p.finding_request_type,
      });
      // Make the first round due now, so it can be done in the demo.
      const r = await api(m.planner, 'POST', `/api/maintenance/planning/inspection-plans/${plan.id}/generate`);
      note(`inspection plan ${p.code}, round ${r.round} due`);
    }
  }

  if ((await rawApi(m.admin, 'GET', '/api/procurement/cost-centres')).status === 200) {
    await costCentres(m.admin, m.costCentres, note);
    const rfqs = await api(m.admin, 'GET', '/api/procurement/rfqs');
    if (!rfqs.some((r) => r.title === m.rfq.title)) {
      const { quotes, ...body } = m.rfq;
      const rfq = await api('priya.procurement', 'POST', '/api/procurement/rfqs', body);
      for (const q of quotes) await api('priya.procurement', 'POST', `/api/procurement/rfqs/${rfq.id}/quotations`, { ...q, currency: 'USD', valid_until: day(30) });
      note(`request for quotation ${rfq.reference_no} with ${quotes.length} quotations (open for award)`);
    }
  } else {
    console.log('  (procurement not available for Meridian: sourcing skipped)');
  }

  if ((await rawApi(RIVERBEND.admin, 'GET', '/api/procurement/cost-centres')).status === 200) await costCentres(RIVERBEND.admin, RIVERBEND.costCentres, note);
}
