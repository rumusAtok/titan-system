import { Module } from '@nestjs/common';
import { bootstrapService, PlatformModule } from '@titan/platform';
import { TenantController } from './tenant.controller.js';
import { TenantService } from './tenant.service.js';

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [TenantController],
  providers: [TenantService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN tenant-service',
  description: 'Organisations, departments, jurisdictions, tenant configuration and organisational memberships.',
  migrations: new URL('../migrations', import.meta.url),
});
