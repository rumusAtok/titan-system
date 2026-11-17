import { z } from 'zod';
import { SWITCHABLE_CAPABILITIES } from './capabilities.js';
import { FieldSpecs, validateFieldValues } from './fields.js';
import { SUBJECT_TYPE_KEYS } from './subjects.js';

/**
 * Industry pack manifest (layer C).
 *
 * A pack is a trusted, versioned, DECLARATIVE document shipped with the
 * platform. It never contains code: it names capabilities to activate and
 * carries templates (workflows, forms, asset categories, sensor profiles,
 * alert rules, dashboards) that the owning services install for a tenant.
 * Anything a manifest refers to by name (datasets, AI tools, icons) must
 * already exist in the platform; a pack cannot introduce behaviour.
 */

const key = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const role = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be MAJOR.MINOR.PATCH');

/** A literal, or a reference to a value of the tenant's pack configuration. */
const ConfigRef = z.object({ $config: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) }).strict();
const NumberOrConfig = z.union([z.number(), ConfigRef]);

export const PackRole = z.object({
  role,
  name: z.string().min(2).max(100),
  description: z.string().max(500),
  /** Descriptive permission names for administrators. Enforcement is by role and capability in the owning service. */
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/)).default([]),
});

export const PackNavigationItem = z.object({
  key,
  label: z.string().min(2).max(60),
  href: z.string().regex(/^\/[a-z0-9\-/]*\/?(\?[a-z0-9_=&-]*)?$/),
  /** Name of an icon known to the web application. */
  icon: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  /** `staff`: any internal staff role. `all`: every signed-in user of the tenant. Ignored when `roles` is given. */
  audience: z.enum(['staff', 'all']).default('staff'),
  /** Restricts the entry to these roles. */
  roles: z.array(role).default([]),
  order: z.number().int().min(0).max(1000).default(500),
});

export const PackWorkflow = z.object({
  key,
  name: z.string().min(2).max(200),
  subject_type: z.enum(SUBJECT_TYPE_KEYS),
  /** Validated against the workflow engine's definition schema by workflow-service. */
  definition: z.record(z.string(), z.unknown()),
});

export const PackForm = z.object({
  key,
  title: z.string().min(2).max(200),
  description: z.string().max(2000).default(''),
  workflow_key: key,
  fields: FieldSpecs.min(1),
});

export const PackAssetCategory = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,32}$/),
  name: z.string().min(2).max(200),
  description: z.string().max(500).default(''),
  /** Versioned attribute schema; a higher version supersedes the previous one for new and edited assets. */
  attribute_schema: z.object({ version: z.number().int().positive(), fields: FieldSpecs.min(1) }).optional(),
});

export const PackSensor = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    label: z.string().min(1).max(100),
    unit: z.string().min(1).max(16),
    min_valid: z.number().nullable().default(null),
    max_valid: z.number().nullable().default(null),
  })
  .refine((s) => s.min_valid === null || s.max_valid === null || s.min_valid < s.max_valid, { message: 'min_valid must be below max_valid' });

export const PackSensorProfile = z.object({
  key,
  name: z.string().min(2).max(200),
  device_type: z.string().min(2).max(64),
  expected_interval_seconds: z.number().int().min(1).max(86_400).default(30),
  sensors: z.array(PackSensor).min(1).max(32),
});

export const PackAlertRule = z.object({
  name: z.string().min(2).max(200),
  sensor_kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  operator: z.enum(['gt', 'gte', 'lt', 'lte']),
  threshold: NumberOrConfig,
  clear_threshold: NumberOrConfig.nullable().default(null),
  severity: z.enum(['info', 'warning', 'critical']),
  create_incident: z.boolean().default(true),
  /** Category of the incident an alarm of this rule opens. */
  incident_category: key.optional(),
});

export const PackIncidentCategory = z.object({
  key,
  name: z.string().min(2).max(100),
  description: z.string().max(500).default(''),
  /** Response workflow started for incidents of this category (subject type `incident`). */
  workflow_key: key.default('incident-response'),
  /** Role told about a new incident of this category. */
  notify_role: role,
  /** Response target per severity, in minutes. An open incident past its target is flagged. */
  response_targets: z.object({ info: z.number().positive().optional(), warning: z.number().positive().optional(), critical: z.number().positive().optional() }).default({}),
});

export const PackRequestType = z.object({
  key,
  name: z.string().min(2).max(100),
  description: z.string().max(500).default(''),
  subject_type: z.enum(['maintenance_request', 'service_request']),
  /** Approval workflow for requests of this type. */
  workflow_key: key,
  default_priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  /** Roles allowed to raise this type of request. */
  requester_roles: z.array(role).min(1),
  /** When set, an incident of this category automatically raises a request of this type. */
  auto_from_incident_category: key.optional(),
  /** Extra details asked for when the request is raised. */
  detail_fields: FieldSpecs.default([]),
});

const column = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const PackWidget = z
  .object({
    id: key,
    title: z.string().min(2).max(100),
    description: z.string().max(300).default(''),
    type: z.enum(['stat', 'timeseries', 'bar', 'table']),
    /** A registered analytical dataset and optional equality filters on its filterable columns. */
    dataset: z.string().regex(/^[a-z][a-z0-9_]{2,62}$/),
    filters: z.record(column, z.union([z.string(), z.number(), z.boolean()])).default({}),
    value: z.object({ column, agg: z.enum(['sum', 'avg', 'min', 'max', 'count']) }).optional(),
    unit: z.string().max(16).optional(),
    x: column.optional(),
    y: column.optional(),
    series: column.optional(),
    category: column.optional(),
    columns: z.array(z.object({ column, label: z.string().min(1).max(60) })).max(12).optional(),
    span: z.number().int().min(1).max(3).default(1),
  })
  .superRefine((w, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (w.type === 'stat') need(!!w.value, 'value', 'a stat widget needs value');
    if (w.type === 'timeseries') need(!!w.x && !!w.y, 'x', 'a timeseries widget needs x and y');
    if (w.type === 'bar') need(!!w.category && !!w.value, 'category', 'a bar widget needs category and value');
    if (w.type === 'table') need(!!w.columns?.length, 'columns', 'a table widget needs columns');
  });
export type PackWidget = z.infer<typeof PackWidget>;

export const PackDashboard = z.object({
  key,
  title: z.string().min(2).max(100),
  description: z.string().max(300).default(''),
  roles: z.array(role).default([]),
  widgets: z.array(PackWidget).min(1).max(24),
});
export type PackDashboard = z.infer<typeof PackDashboard>;

export const PackManifest = z
  .object({
    schema_version: z.literal(1),
    id: key,
    version: SemVer,
    name: z.string().min(2).max(100),
    industry: z.string().min(2).max(100),
    description: z.string().max(1000),
    requires: z
      .object({
        /** Layer B capabilities this pack switches on for the tenant. */
        capabilities: z.array(z.string()).default([]),
        /** Other packs that must be active first. */
        packs: z.array(z.object({ id: key, min_version: SemVer.optional() })).default([]),
      })
      .default({ capabilities: [], packs: [] }),
    roles: z.array(PackRole).default([]),
    navigation: z.array(PackNavigationItem).default([]),
    workflows: z.array(PackWorkflow).default([]),
    forms: z.array(PackForm).default([]),
    asset_categories: z.array(PackAssetCategory).default([]),
    sensor_profiles: z.array(PackSensorProfile).default([]),
    alert_rules: z.array(PackAlertRule).default([]),
    incident_categories: z.array(PackIncidentCategory).default([]),
    request_types: z.array(PackRequestType).default([]),
    dashboards: z.array(PackDashboard).default([]),
    /** Approved analytical query templates the pack makes available (by name). */
    query_templates: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,62}$/)).default([]),
    /** AI tools the pack makes available (by name; implemented and reviewed in ai-gateway-service). */
    ai_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,62}$/)).default([]),
    /** Tenant-adjustable settings of the pack. */
    config_schema: FieldSpecs.default([]),
    config_defaults: z.record(z.string(), z.unknown()).default({}),
    lifecycle: z
      .object({
        /** Versions this version can be upgraded from in place. */
        upgrades_from: z.array(SemVer).default([]),
        changes: z.array(z.string().max(300)).default([]),
        /** What stays behind when the pack is deactivated (always: all business records). */
        on_deactivate: z.string().max(500).default('Capabilities are withdrawn. No business record, definition or configuration is deleted.'),
      })
      .default({ upgrades_from: [], changes: [], on_deactivate: 'Capabilities are withdrawn. No business record, definition or configuration is deleted.' }),
  })
  .superRefine((m, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    m.requires.capabilities.forEach((c, i) => {
      if (!SWITCHABLE_CAPABILITIES.includes(c)) issue(['requires', 'capabilities', i], `'${c}' is not a switchable platform capability`);
    });
    const caps = new Set(m.requires.capabilities);
    const unique = (items: string[], path: string, what: string) => {
      const seen = new Set<string>();
      items.forEach((k, i) => {
        if (seen.has(k)) issue([path, i], `duplicate ${what} '${k}'`);
        seen.add(k);
      });
    };
    unique(m.workflows.map((w) => w.key), 'workflows', 'workflow key');
    unique(m.forms.map((f) => f.key), 'forms', 'form key');
    unique(m.asset_categories.map((c) => c.code), 'asset_categories', 'category code');
    unique(m.sensor_profiles.map((p) => p.key), 'sensor_profiles', 'profile key');
    unique(m.alert_rules.map((r) => r.name), 'alert_rules', 'rule name');
    unique(m.incident_categories.map((c) => c.key), 'incident_categories', 'category key');
    unique(m.request_types.map((t) => t.key), 'request_types', 'request type key');
    unique(m.dashboards.map((d) => d.key), 'dashboards', 'dashboard key');
    unique(m.navigation.map((n) => n.key), 'navigation', 'navigation key');

    // A template needs the capability whose service installs it.
    if (m.forms.length && !caps.has('case_management')) issue(['forms'], "forms need the 'case_management' capability");
    if ((m.sensor_profiles.length || m.alert_rules.length) && !caps.has('iot')) issue(['sensor_profiles'], "sensor profiles and alert rules need the 'iot' capability");
    if (m.request_types.length && !caps.has('maintenance')) issue(['request_types'], "request types need the 'maintenance' capability");

    // References inside the manifest must resolve.
    const workflowKeys = new Map(m.workflows.map((w) => [w.key, w.subject_type]));
    m.forms.forEach((f, i) => {
      if (workflowKeys.get(f.workflow_key) !== 'case') issue(['forms', i, 'workflow_key'], `form '${f.key}' needs a workflow of subject type 'case' in this pack`);
    });
    m.request_types.forEach((t, i) => {
      if (workflowKeys.get(t.workflow_key) !== t.subject_type) {
        issue(['request_types', i, 'workflow_key'], `request type '${t.key}' needs a workflow of subject type '${t.subject_type}' in this pack`);
      }
    });
    m.incident_categories.forEach((c, i) => {
      if (c.workflow_key !== 'incident-response' && workflowKeys.get(c.workflow_key) !== 'incident') {
        issue(['incident_categories', i, 'workflow_key'], `incident category '${c.key}' needs a workflow of subject type 'incident' in this pack`);
      }
    });
    const configKeys = new Set(m.config_schema.map((f) => f.name));
    m.alert_rules.forEach((r, i) => {
      for (const field of ['threshold', 'clear_threshold'] as const) {
        const v = r[field];
        if (v && typeof v === 'object' && !configKeys.has(v.$config)) issue(['alert_rules', i, field], `unknown configuration key '${v.$config}'`);
      }
    });
    const defaults = validateFieldValues(m.config_schema, m.config_defaults);
    defaults.forEach((d) => issue(['config_defaults', d.field], d.message));
  });

export type PackManifest = z.infer<typeof PackManifest>;
export type PackManifestInput = z.input<typeof PackManifest>;

/**
 * What the owning services install for a tenant: the templates of a manifest
 * with every configuration reference replaced by the tenant's value.
 */
export interface PackInstall {
  workflows: PackManifest['workflows'];
  forms: PackManifest['forms'];
  asset_categories: PackManifest['asset_categories'];
  sensor_profiles: PackManifest['sensor_profiles'];
  alert_rules: (Omit<PackManifest['alert_rules'][number], 'threshold' | 'clear_threshold'> & { threshold: number; clear_threshold: number | null })[];
  incident_categories: PackManifest['incident_categories'];
  request_types: PackManifest['request_types'];
}

export class PackConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'PackConfigError';
  }
}

/** Effective configuration: manifest defaults overlaid with the tenant's values, validated against the schema. */
export function effectivePackConfig(manifest: PackManifest, tenantConfig: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...manifest.config_defaults, ...tenantConfig };
  const issues = validateFieldValues(manifest.config_schema, merged);
  if (issues.length) throw new PackConfigError('pack configuration is invalid', issues);
  return merged;
}

export function resolvePackInstall(manifest: PackManifest, tenantConfig: Record<string, unknown> = {}): PackInstall {
  const config = effectivePackConfig(manifest, tenantConfig);
  const number = (value: number | { $config: string }, what: string): number => {
    if (typeof value === 'number') return value;
    const resolved = config[value.$config];
    if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
      throw new PackConfigError('pack configuration is invalid', [{ field: value.$config, message: `must be a number (used by ${what})` }]);
    }
    return resolved;
  };
  return {
    workflows: manifest.workflows,
    forms: manifest.forms,
    asset_categories: manifest.asset_categories,
    sensor_profiles: manifest.sensor_profiles,
    alert_rules: manifest.alert_rules.map((r) => ({
      ...r,
      threshold: number(r.threshold, `alert rule '${r.name}'`),
      clear_threshold: r.clear_threshold === null ? null : number(r.clear_threshold, `alert rule '${r.name}'`),
    })),
    incident_categories: manifest.incident_categories,
    request_types: manifest.request_types,
  };
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
