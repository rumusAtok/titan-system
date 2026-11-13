import { Controller, Get, Header, Inject, Optional, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@titan/authentication';
import { metricsText } from '@titan/observability';
import { CONFIG, type PlatformConfig } from './config.js';
import { Db } from './db.js';
import { NatsClient } from './nats.js';

@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(NatsClient) private readonly nats: NatsClient,
    @Optional() @Inject(Db) private readonly db?: Db,
  ) {}

  /** Liveness: the process is running and its event loop responds. */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok', service: this.config.SERVICE_NAME };
  }

  /**
   * Readiness: the service can do useful work. The database is required.
   * The event broker is reported but not required, because writes are
   * buffered in the outbox while it is unavailable.
   */
  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const database = this.db ? ((await this.db.ping()) ? 'up' : 'down') : 'not_used';
    const broker = this.nats.connected ? 'up' : 'down';
    const ready = database !== 'down';
    if (!ready) res.status(503);
    return {
      status: !ready ? 'unavailable' : broker === 'up' ? 'ok' : 'degraded',
      service: this.config.SERVICE_NAME,
      checks: { database, broker },
    };
  }

  @Public()
  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Res() res: { setHeader(k: string, v: string): void; end(body: string): void }) {
    const { contentType, body } = await metricsText();
    res.setHeader('Content-Type', contentType);
    res.end(body);
  }
}
