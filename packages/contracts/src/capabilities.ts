/**
 * Platform capability registry.
 *
 * TITAN is layered:
 *   A. universal platform core   - always available to every tenant
 *   B. reusable business capabilities - switched on per tenant by industry packs
 *   C. industry packs            - declarative configuration that activates
 *                                  capabilities and installs templates
 *
 * A capability is a unit of *server-side* entitlement: the service that owns
 * it refuses its API to tenants that have not activated it, whatever the
 * user interface shows.
 */
export const Capabilities = {
  CaseManagement: 'case_management',
  Iot: 'iot',
  Maintenance: 'maintenance',
} as const;

export type Capability = (typeof Capabilities)[keyof typeof Capabilities];

export interface CapabilityInfo {
  key: string;
  name: string;
  description: string;
  layer: 'core' | 'capability';
  /** Services that enforce (and implement) the capability. */
  services: string[];
}

export const CAPABILITY_CATALOG: readonly CapabilityInfo[] = [
  // Layer A: universal platform core. Not switchable.
  { key: 'tenancy', name: 'Identity and tenancy', description: 'Organisations, sites, memberships, entitlements', layer: 'core', services: ['tenant-service'] },
  { key: 'workflow', name: 'Workflow', description: 'Versioned approval processes for any registered business subject', layer: 'core', services: ['workflow-service'] },
  { key: 'incidents', name: 'Incidents', description: 'Incident lifecycle with categories and typed origins', layer: 'core', services: ['incident-service'] },
  { key: 'assets', name: 'Assets', description: 'Asset register, hierarchy, lifecycle, category attribute schemas', layer: 'core', services: ['asset-service'] },
  { key: 'notifications', name: 'Notifications', description: 'In-application notifications', layer: 'core', services: ['notification-service'] },
  { key: 'audit', name: 'Audit', description: 'Append-only record of business and security events', layer: 'core', services: ['audit-service'] },
  { key: 'analytics', name: 'Analytics', description: 'Registered analytical datasets and approved queries', layer: 'core', services: ['analytics-service', 'data-pipeline-service'] },
  { key: 'ai', name: 'AI assistant', description: 'Optional, permission-aware assistant', layer: 'core', services: ['ai-gateway-service'] },
  // Layer B: reusable business capabilities, activated by packs.
  {
    key: Capabilities.CaseManagement,
    name: 'Case management',
    description: 'Configurable forms and cases routed through approval workflows',
    layer: 'capability',
    services: ['case-service'],
  },
  {
    key: Capabilities.Iot,
    name: 'Device telemetry and alerting',
    description: 'Device registry, sensor profiles, MQTT telemetry, threshold alarms',
    layer: 'capability',
    services: ['device-service', 'telemetry-service', 'alert-service'],
  },
  {
    key: Capabilities.Maintenance,
    name: 'Maintenance',
    description: 'Maintenance and service requests, approval, work orders',
    layer: 'capability',
    services: ['maintenance-service'],
  },
];

/** Capabilities a pack may request (layer B). Core capabilities are implicit. */
export const SWITCHABLE_CAPABILITIES: readonly string[] = CAPABILITY_CATALOG.filter((c) => c.layer === 'capability').map((c) => c.key);

export function isSwitchableCapability(key: string): boolean {
  return SWITCHABLE_CAPABILITIES.includes(key);
}
