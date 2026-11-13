import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles, STAFF_ROLES } from '@titan/contracts';
import { EventStream } from './event-stream.js';
import { type Upstream, UPSTREAMS } from './upstreams.js';

const OPERATIONS_ROLES = [...STAFF_ROLES, Roles.PlatformAdmin, Roles.DrOperator];

interface ServiceHealth {
  key: string;
  service: string;
  critical: boolean;
  status: 'ok' | 'degraded' | 'unavailable' | 'unreachable';
  checks: Record<string, string> | null;
  circuit: string;
  latency_ms: number | null;
  checked_at: string;
}

async function probe(upstream: Upstream): Promise<ServiceHealth> {
  const started = Date.now();
  const base = { key: upstream.key, service: upstream.service, critical: upstream.critical, circuit: upstream.breaker.status, checked_at: new Date().toISOString() };
  try {
    const response = await fetch(`${upstream.baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_500) });
    const body = (await response.json().catch(() => null)) as { status?: string; checks?: Record<string, string> } | null;
    const status = response.ok ? (body?.status === 'degraded' ? 'degraded' : 'ok') : 'unavailable';
    return { ...base, status, checks: body?.checks ?? null, latency_ms: Date.now() - started };
  } catch {
    return { ...base, status: 'unreachable', checks: null, latency_ms: null };
  }
}

@ApiTags('platform')
@ApiBearerAuth()
@Controller('api/platform')
export class PlatformController {
  constructor(@Inject(UPSTREAMS) private readonly upstreams: Map<string, Upstream>) {}

  @Get('health')
  @RequireRoles(...OPERATIONS_ROLES)
  @ApiOperation({ summary: 'Live readiness of every service, probed at request time' })
  async health() {
    const services = await Promise.all([...this.upstreams.values()].map(probe));
    const criticalDown = services.some((s) => s.critical && s.status !== 'ok' && s.status !== 'degraded');
    const anyDown = services.some((s) => s.status !== 'ok');
    return {
      status: criticalDown ? 'critical_outage' : anyDown ? 'degraded' : 'ok',
      environment: process.env.TITAN_ENVIRONMENT ?? 'local-development',
      checked_at: new Date().toISOString(),
      services,
    };
  }
}

@ApiTags('stream')
@ApiBearerAuth()
@Controller('api/stream')
export class StreamController {
  constructor(@Inject(EventStream) private readonly stream: EventStream) {}

  @Get('events')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: "Server-Sent Events stream of the caller's tenant operational events" })
  events(@CurrentUser() user: Principal, @Req() req: any, @Res() res: any) {
    this.stream.attach(user, req, res);
  }
}
