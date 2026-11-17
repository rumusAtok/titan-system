import { Module } from '@nestjs/common';
import { bootstrapService, PlatformModule } from '@titan/platform';
import { PacksController } from './packs.controller.js';
import { PacksService } from './packs.service.js';
import { TenantController } from './tenant.controller.js';
import { TenantService } from './tenant.service.js';

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [TenantController, PacksController],
  providers: [PacksService, TenantService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN tenant-service',
  description:
    'Organisations, sites, departments, memberships, and the industry-pack registry: catalogue, tenant activation, entitlements, ' +
    'workspace navigation and dashboards.',
  migrations: new URL('../migrations', import.meta.url),
});
