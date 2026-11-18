// Contract test for the industry-pack manifests shipped with tenant-service.
// Needs no running stack: it checks every manifest against the manifest
// schema and against the schemas of the services that will install its parts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// Compiled output (`npm run build`): the sources use `.js` import specifiers, which Node cannot map back to `.ts`.
import { compareVersions, PackManifest, resolvePackInstall, SUBJECT_TYPES } from '@titan/contracts';
import { FormFields } from '../../services/case-service/dist/forms.js';
import { Definition } from '../../services/workflow-service/dist/engine.js';

const PACKS_DIR = fileURLToPath(new URL('../../services/tenant-service/packs', import.meta.url));

const manifests = readdirSync(PACKS_DIR).flatMap((id) =>
  readdirSync(path.join(PACKS_DIR, id))
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ id, file, raw: JSON.parse(readFileSync(path.join(PACKS_DIR, id, file), 'utf8')) })),
);

// Names a manifest may refer to. Kept in step with the services that implement them
// (analytics-service datasets and templates, ai-gateway-service tools, web icons).
const DATASETS = new Set([
  'approval_turnaround', 'pending_tasks', 'incidents_by_severity', 'incidents_by_category', 'sensor_availability', 'water_level_trend',
  'asset_maintenance_status', 'metric_trend', 'maintenance_requests', 'maintenance_work_orders', 'work_order_turnaround',
]);
const ICONS = new Set(['layout-dashboard', 'inbox', 'boxes', 'siren', 'bot', 'settings', 'life-buoy', 'gauge', 'file-text', 'clipboard-check', 'activity', 'map', 'factory', 'wrench', 'building', 'map-pin', 'shopping-cart', 'bar-chart', 'plug', 'video', 'network']);

describe('industry pack manifests', () => {
  it('ships the expected packs', () => {
    const ids = [...new Set(manifests.map((m) => m.id))].sort();
    assert.deepEqual(ids, ['disaster-infrastructure', 'facilities', 'integration-hub', 'manufacturing', 'operational-reporting', 'platform-core', 'procurement-inventory', 'public-services', 'video-monitoring']);
  });

  for (const { id, file, raw } of manifests) {
    describe(`${id}/${file}`, () => {
      const parsed = PackManifest.safeParse(raw);

      it('is a valid manifest stored under its own id and version', () => {
        assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2));
        assert.equal(parsed.data.id, id);
        assert.equal(`${parsed.data.version}.json`, file);
      });

      it('carries workflow definitions the workflow engine accepts, for registered subject types', () => {
        assert.ok(parsed.success);
        for (const w of parsed.data.workflows) {
          const definition = Definition.safeParse(w.definition);
          assert.ok(definition.success, `${w.key}: ${definition.success ? '' : JSON.stringify(definition.error.issues)}`);
          const subject = SUBJECT_TYPES.find((s) => s.key === w.subject_type);
          assert.ok(subject, `${w.key}: unregistered subject type ${w.subject_type}`);
          if (!subject.supportsReturn) assert.equal(definition.data.allow_return, false, `${w.key}: only cases can be returned for changes`);
          if (w.subject_type === 'incident') {
            assert.deepEqual(definition.data.stages.map((s) => s.key), ['acknowledge', 'resolve'], `${w.key}: incident processes use the stages acknowledge and resolve`);
          }
        }
      });

      it('carries forms the case service accepts', () => {
        assert.ok(parsed.success);
        for (const f of parsed.data.forms) {
          const fields = FormFields.safeParse(f.fields);
          assert.ok(fields.success, `${f.key}: ${fields.success ? '' : JSON.stringify(fields.error.issues)}`);
        }
      });

      it('resolves to an installable set of templates with its default configuration', () => {
        assert.ok(parsed.success);
        const install = resolvePackInstall(parsed.data);
        for (const rule of install.alert_rules) {
          assert.equal(typeof rule.threshold, 'number');
          if (rule.clear_threshold !== null) {
            const safeSide = rule.operator.startsWith('g') ? rule.clear_threshold <= rule.threshold : rule.clear_threshold >= rule.threshold;
            assert.ok(safeSide, `${rule.name}: clear threshold must be on the safe side of the threshold`);
          }
          if (rule.incident_category) {
            const known = [...parsed.data.incident_categories.map((c) => c.key), 'general'];
            assert.ok(known.includes(rule.incident_category), `${rule.name}: unknown incident category ${rule.incident_category}`);
          }
        }
        for (const type of install.request_types) {
          if (type.auto_from_incident_category) {
            assert.ok(parsed.data.incident_categories.some((c) => c.key === type.auto_from_incident_category), `${type.key}: unknown incident category`);
          }
        }
      });

      it('refers only to datasets, icons and roles that exist', () => {
        assert.ok(parsed.success);
        for (const d of parsed.data.dashboards) for (const w of d.widgets) assert.ok(DATASETS.has(w.dataset), `widget ${w.id}: unknown dataset ${w.dataset}`);
        for (const n of parsed.data.navigation) assert.ok(ICONS.has(n.icon), `navigation ${n.key}: unknown icon ${n.icon}`);
        const stageRoles = parsed.data.workflows.flatMap((w) => Definition.parse(w.definition).stages.flatMap((s) => [...s.roles, ...(s.escalate_to_role ? [s.escalate_to_role] : [])]));
        const declared = new Set([...parsed.data.roles.map((r) => r.role), 'tenant_admin', 'duty_officer', 'incident_commander']);
        for (const r of stageRoles) assert.ok(declared.has(r), `role ${r} is used in a workflow but not described by the pack`);
      });
    });
  }

  it('gives every later version an upgrade path from an earlier one', () => {
    const byId = new Map<string, string[]>();
    for (const m of manifests) byId.set(m.id, [...(byId.get(m.id) ?? []), m.raw.version]);
    for (const [id, versions] of byId) {
      const sorted = versions.sort(compareVersions);
      for (const version of sorted.slice(1)) {
        const manifest = manifests.find((m) => m.id === id && m.raw.version === version)!.raw;
        const from: string[] = manifest.lifecycle?.upgrades_from ?? [];
        assert.ok(from.some((v) => sorted.includes(v) && compareVersions(v, version) < 0), `${id}@${version} declares no upgrade path`);
      }
    }
  });
});
