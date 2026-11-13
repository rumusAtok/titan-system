import { Bulkhead, CircuitBreaker } from '@titan/platform';

export interface Upstream {
  key: string;
  service: string;
  baseUrl: string;
  timeoutMs: number;
  /** false: the platform's critical functions keep working without it. */
  critical: boolean;
  breaker: CircuitBreaker;
  bulkhead: Bulkhead;
}

interface UpstreamSpec {
  key: string;
  service: string;
  port: number;
  timeoutMs?: number;
  critical?: boolean;
}

/** Public route key (`/api/<key>/...`) -> owning service. */
const SPECS: UpstreamSpec[] = [
  { key: 'tenant', service: 'tenant-service', port: 3000, critical: true },
  { key: 'case', service: 'case-service', port: 3000, critical: true },
  { key: 'workflow', service: 'workflow-service', port: 3000, critical: true },
  { key: 'notification', service: 'notification-service', port: 3000 },
  { key: 'audit', service: 'audit-service', port: 3000 },
  { key: 'asset', service: 'asset-service', port: 3000 },
  { key: 'device', service: 'device-service', port: 3000, critical: true },
  { key: 'telemetry', service: 'telemetry-service', port: 3000, critical: true },
  { key: 'alert', service: 'alert-service', port: 3000, critical: true },
  { key: 'incident', service: 'incident-service', port: 3000, critical: true },
  { key: 'analytics', service: 'analytics-service', port: 8000 },
  { key: 'pipeline', service: 'data-pipeline-service', port: 8000, timeoutMs: 120_000 },
  { key: 'ai', service: 'ai-gateway-service', port: 8000, timeoutMs: 180_000 },
];

export function buildUpstreams(env: NodeJS.ProcessEnv = process.env): Map<string, Upstream> {
  const map = new Map<string, Upstream>();
  for (const spec of SPECS) {
    const override = env[`UPSTREAM_${spec.key.toUpperCase()}`];
    map.set(spec.key, {
      key: spec.key,
      service: spec.service,
      baseUrl: (override ?? `http://${spec.service}:${spec.port}`).replace(/\/+$/, ''),
      timeoutMs: spec.timeoutMs ?? 15_000,
      critical: spec.critical ?? false,
      // Separate breaker and concurrency budget per dependency: one slow or
      // failing service cannot consume the gateway's capacity for the others.
      breaker: new CircuitBreaker(spec.service, { failureThreshold: 5, resetTimeoutMs: 10_000 }),
      bulkhead: new Bulkhead(spec.service, Number(env.UPSTREAM_MAX_CONCURRENT ?? 64)),
    });
  }
  return map;
}

export const UPSTREAMS = Symbol('UPSTREAMS');
