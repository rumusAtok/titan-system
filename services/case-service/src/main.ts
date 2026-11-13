import { Module } from '@nestjs/common';
import { bootstrapService, PlatformModule } from '@titan/platform';
import { CaseController } from './case.controller.js';
import { CaseService } from './case.service.js';

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [CaseController],
  providers: [CaseService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN case-service',
  description: 'Applications, configurable forms, case records, submissions, lifecycle states and applicant tracking.',
  migrations: new URL('../migrations', import.meta.url),
  // Attachments arrive base64-encoded in JSON (2 MB binary is roughly 2.7 MB of base64).
  jsonLimit: '4mb',
});
