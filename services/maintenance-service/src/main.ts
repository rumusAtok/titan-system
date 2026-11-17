import { Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Capabilities, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, RequireCapability, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import {
  AssignWorkOrder,
  CancelWorkOrder,
  CompleteWorkOrder,
  CreateRequest,
  ListRequests,
  ListWorkOrders,
  MaintenanceService,
  PLANNING_ROLES,
} from './maintenance.service.js';

@ApiTags('maintenance')
@ApiBearerAuth()
@Controller()
@RequireCapability(Capabilities.Maintenance)
class MaintenanceController {
  constructor(@Inject(MaintenanceService) private readonly maintenance: MaintenanceService) {}

  @Get('request-types')
  @ApiOperation({ summary: 'Kinds of request the tenant can raise, their detail fields, and whether the caller may raise them' })
  requestTypes(@CurrentUser() user: Principal) {
    return this.maintenance.listRequestTypes(user);
  }

  @Get('requests')
  @ApiOperation({ summary: 'Maintenance and service requests. Staff see all of the tenant; other users only their own.' })
  listRequests(@CurrentUser() user: Principal, @ZQuery(ListRequests) query: z.infer<typeof ListRequests>) {
    return this.maintenance.listRequests(user, query);
  }

  @Post('requests')
  @ApiOperation({
    summary: 'Raise a maintenance or service request',
    description: 'The caller needs one of the request type\'s requester roles. The request goes to the approval workflow the type names; approval creates a work order.',
  })
  createRequest(@CurrentUser() user: Principal, @ZBody(CreateRequest) body: z.infer<typeof CreateRequest>) {
    return this.maintenance.createRequest(user, body);
  }

  @Get('requests/:id')
  getRequest(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.maintenance.getRequest(user, id);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw a request that has not been decided (requester or planner)' })
  cancelRequest(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.maintenance.cancelRequest(user, id);
  }

  @Get('work-orders')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Work orders; status=active returns open, assigned and in-progress orders; mine=true only the caller\'s' })
  listWorkOrders(@CurrentUser() user: Principal, @ZQuery(ListWorkOrders) query: z.infer<typeof ListWorkOrders>) {
    return this.maintenance.listWorkOrders(user, query);
  }

  @Get('work-orders/:id')
  @RequireRoles(...STAFF_ROLES)
  getWorkOrder(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.maintenance.getWorkOrder(user, id);
  }

  @Post('work-orders/:id/assign')
  @HttpCode(200)
  @RequireRoles(...PLANNING_ROLES)
  @ApiOperation({ summary: 'Assign (or, before work starts, re-assign) a work order' })
  assign(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AssignWorkOrder) body: z.infer<typeof AssignWorkOrder>) {
    return this.maintenance.assign(user, id, body);
  }

  @Post('work-orders/:id/start')
  @HttpCode(200)
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Start work (the assigned technician, or a planner)' })
  start(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.maintenance.start(user, id);
  }

  @Post('work-orders/:id/complete')
  @HttpCode(200)
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Complete work with a summary, labour hours and the asset\'s condition (the assigned technician, or a planner)' })
  complete(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(CompleteWorkOrder) body: z.infer<typeof CompleteWorkOrder>) {
    return this.maintenance.complete(user, id, body);
  }

  @Post('work-orders/:id/cancel')
  @HttpCode(200)
  @RequireRoles(...PLANNING_ROLES)
  cancelWorkOrder(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(CancelWorkOrder) body: z.infer<typeof CancelWorkOrder>) {
    return this.maintenance.cancelWorkOrder(user, id, body);
  }

  @Get('summary')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Request and work order counts by industry pack and status, and completed-work turnaround' })
  summary(@CurrentUser() user: Principal) {
    return this.maintenance.summary(user);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN maintenance-service',
  description:
    'Maintenance and service requests, their approval outcome and work orders. Request types are installed by industry packs; ' +
    'approval is decided by the workflow each request type names.',
  migrations: new URL('../migrations', import.meta.url),
});
