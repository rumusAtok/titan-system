import { Controller, Get, HttpCode, Inject, Module, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, Public, RequireRoles } from '@titan/authentication';
import { Capabilities } from '@titan/contracts';
import { bootstrapService, PlatformModule, RequireCapability, uuidParam, ZBody } from '@titan/platform';
import type { z } from 'zod';
import { ADMINS, CreateEndpoint, CreateSubscription, IntegrationService, READERS, UpdateActive, UpdateSubscription } from './integration.service.js';

const INBOUND_MAX_BYTES = 256 * 1024;

interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}
interface RawResponse {
  status(code: number): RawResponse;
  json(body: unknown): void;
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
@RequireRoles(...READERS)
@RequireCapability(Capabilities.Integrations)
class IntegrationController {
  constructor(@Inject(IntegrationService) private readonly integrations: IntegrationService) {}

  @Get('catalogue')
  @ApiOperation({ summary: 'Event types that can be forwarded, destination hosts on the allow-list, and the signature scheme' })
  catalogue() {
    return this.integrations.catalogue();
  }

  @Get('endpoints')
  endpoints(@CurrentUser() user: Principal) {
    return this.integrations.listEndpoints(user);
  }

  @Post('endpoints')
  @RequireRoles(...ADMINS)
  @ApiOperation({ summary: 'Create an inbound incident endpoint. The signing secret is returned once' })
  createEndpoint(@CurrentUser() user: Principal, @ZBody(CreateEndpoint) body: z.infer<typeof CreateEndpoint>) {
    return this.integrations.createEndpoint(user, body);
  }

  @Post('endpoints/:id/rotate-secret')
  @HttpCode(200)
  @RequireRoles(...ADMINS)
  rotate(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.integrations.rotateEndpointSecret(user, id);
  }

  @Patch('endpoints/:id')
  @RequireRoles(...ADMINS)
  setActive(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateActive) body: z.infer<typeof UpdateActive>) {
    return this.integrations.setEndpointActive(user, id, body.active);
  }

  @Get('endpoints/:id/messages')
  @ApiOperation({ summary: 'Requests received on an endpoint: accepted, duplicate and rejected (with reason)' })
  messages(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.integrations.endpointMessages(user, id);
  }

  @Get('subscriptions')
  subscriptions(@CurrentUser() user: Principal) {
    return this.integrations.listSubscriptions(user);
  }

  @Post('subscriptions')
  @RequireRoles(...ADMINS)
  @ApiOperation({ summary: 'Forward selected events to an allow-listed destination, signed. The signing secret is returned once' })
  createSubscription(@CurrentUser() user: Principal, @ZBody(CreateSubscription) body: z.infer<typeof CreateSubscription>) {
    return this.integrations.createSubscription(user, body);
  }

  @Patch('subscriptions/:id')
  @RequireRoles(...ADMINS)
  updateSubscription(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateSubscription) body: z.infer<typeof UpdateSubscription>) {
    return this.integrations.updateSubscription(user, id, body);
  }

  @Get('subscriptions/:id/deliveries')
  deliveries(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.integrations.deliveries(user, id);
  }

  @Post('deliveries/:id/retry')
  @HttpCode(200)
  @RequireRoles(...ADMINS)
  retry(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.integrations.retryDelivery(user, id);
  }
}

/** Reached through the gateway's public `/hooks/<id>` relay. Authenticated by signature, not by token. */
@ApiExcludeController()
@Controller('inbound')
class InboundController {
  constructor(@Inject(IntegrationService) private readonly integrations: IntegrationService) {}

  @Public()
  @Post(':id')
  async inbound(@Param('id', uuidParam) id: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    const result = await this.integrations.receive(id, req.headers, req.rawBody);
    res.status(result.status).json(result.body);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [IntegrationController, InboundController],
  providers: [IntegrationService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN integration-service',
  description: 'Signed inbound webhooks that report incidents, and outbound event subscriptions delivered (signed, with retries) to allow-listed destinations only.',
  migrations: new URL('../migrations', import.meta.url),
  // The signature covers the exact bytes received, so inbound bodies are kept raw.
  jsonBody: false,
  configure(app) {
    app.use('/inbound', (req: RawRequest & AsyncIterable<Buffer> & { _body?: boolean }, res: { statusCode: number; setHeader(k: string, v: string): void; end(b: string): void }, next: (err?: unknown) => void) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > INBOUND_MAX_BYTES) {
            res.statusCode = 413;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: { status: 413, code: 'payload_too_large', message: 'request body too large' } }));
            return;
          }
          chunks.push(chunk);
        }
        req.rawBody = Buffer.concat(chunks);
        req._body = true; // tells the JSON parser the body has been read
        next();
      })().catch(next);
    });
    app.useBodyParser('json', { limit: '256kb' });
  },
});
