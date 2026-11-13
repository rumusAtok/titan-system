import { Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles, STAFF_ROLES } from '@titan/contracts';
import { DomainError, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { CreateDefinition, CreateDelegation, DecideTask, ListTasks, WorkflowService } from './workflow.service.js';

@ApiTags('workflow')
@ApiBearerAuth()
@Controller()
export class WorkflowController {
  constructor(@Inject(WorkflowService) private readonly workflow: WorkflowService) {}

  @Get('definitions')
  @RequireRoles(...STAFF_ROLES)
  listDefinitions(@CurrentUser() user: Principal) {
    return this.workflow.listDefinitions(user);
  }

  @Post('definitions')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Publish a new version of a workflow definition' })
  createDefinition(@CurrentUser() user: Principal, @ZBody(CreateDefinition) body: z.infer<typeof CreateDefinition>) {
    return this.workflow.createDefinition(user, body);
  }

  @Get('tasks')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: "Review inbox: tasks for the caller's roles and active delegations" })
  listTasks(@CurrentUser() user: Principal, @ZQuery(ListTasks) query: z.infer<typeof ListTasks>) {
    return this.workflow.listTasks(user, query);
  }

  @Post('tasks/:id/decision')
  @HttpCode(200)
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({
    summary: 'Approve, reject or return a task',
    description:
      'The caller must hold the role the task is assigned to, or an active delegation of it. ' +
      'A task can be decided once; send an Idempotency-Key header to make retries safe.',
  })
  decide(
    @CurrentUser() user: Principal,
    @Param('id', uuidParam) id: string,
    @ZBody(DecideTask) body: z.infer<typeof DecideTask>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw DomainError.invalid('Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]');
    }
    return this.workflow.decide(user, id, body, idempotencyKey ?? null);
  }

  @Get('instances/by-subject/:subjectType/:subjectId')
  @ApiOperation({ summary: 'Process state, planned stages, tasks and decision history for a case or incident' })
  bySubject(@CurrentUser() user: Principal, @Param('subjectType') subjectType: string, @Param('subjectId', uuidParam) subjectId: string) {
    return this.workflow.getInstanceBySubject(user, subjectType, subjectId);
  }

  @Get('instances/:id')
  getInstance(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.workflow.getInstance(user, id);
  }

  @Get('stats')
  @RequireRoles(...STAFF_ROLES)
  stats(@CurrentUser() user: Principal) {
    return this.workflow.stats(user);
  }

  @Get('delegations')
  @RequireRoles(...STAFF_ROLES)
  listDelegations(@CurrentUser() user: Principal) {
    return this.workflow.listDelegations(user);
  }

  @Post('delegations')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Delegate one of your own roles to another user for a limited time' })
  createDelegation(@CurrentUser() user: Principal, @ZBody(CreateDelegation) body: z.infer<typeof CreateDelegation>) {
    return this.workflow.createDelegation(user, body);
  }

  @Delete('delegations/:id')
  @RequireRoles(...STAFF_ROLES)
  revokeDelegation(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.workflow.revokeDelegation(user, id);
  }
}
