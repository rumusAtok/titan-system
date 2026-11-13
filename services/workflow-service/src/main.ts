import { Module } from '@nestjs/common';
import { bootstrapService, PlatformModule } from '@titan/platform';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowService } from './workflow.service.js';

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [WorkflowController],
  providers: [WorkflowService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN workflow-service',
  description: 'Versioned approval processes, role-based task assignment, delegations, decisions, SLA tracking and escalation.',
  migrations: new URL('../migrations', import.meta.url),
});
