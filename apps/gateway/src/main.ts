import { Module } from '@nestjs/common';
import { JwtVerifier } from '@titan/authentication';
import type { Logger } from '@titan/observability';
import { bootstrapService, LOGGER, PlatformModule } from '@titan/platform';
import { DrController } from './dr.controller.js';
import { EventStream } from './event-stream.js';
import { PlatformController, StreamController } from './platform.controller.js';
import { createProxy } from './proxy.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { buildUpstreams, type Upstream, UPSTREAMS } from './upstreams.js';

@Module({
  imports: [PlatformModule.forRoot({ database: false })],
  controllers: [PlatformController, StreamController, DrController],
  providers: [EventStream, { provide: UPSTREAMS, useValue: buildUpstreams() }],
})
export class AppModule {}

const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((o) => o.trim());

await bootstrapService({
  module: AppModule,
  title: 'TITAN API gateway',
  description: 'Edge entry point: authentication, rate limiting, resilient routing to services, aggregated health and the live event stream.',
  // Bodies are forwarded untouched to the owning service, which validates them.
  jsonBody: false,
  configure(app) {
    app.enableCors({
      origin: allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-correlation-id', 'idempotency-key'],
      exposedHeaders: ['x-correlation-id', 'retry-after', 'content-disposition'],
      maxAge: 600,
    });
    app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('cache-control', 'no-store');
      next();
    });

    const limiter = new TokenBucketLimiter(Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600));
    setInterval(() => limiter.sweep(), 60_000).unref();

    app.use(
      '/api',
      createProxy({
        upstreams: app.get<Map<string, Upstream>>(UPSTREAMS),
        verifier: app.get(JwtVerifier),
        limiter,
        logger: app.get<Logger>(LOGGER),
      }),
    );
  },
});
