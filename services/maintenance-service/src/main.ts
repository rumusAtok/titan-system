import { Controller, DefaultValuePipe, Get, HttpCode, Inject, Module, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
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
  MaintenanceSettings,
  PLANNING_ROLES,
} from './maintenance.service.js';
import { CompleteRound, CreateInspectionPlan, CreatePmPlan, PlanningService, SetActive } from './planning.service.js';

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

  @Get('settings')
  @RequireRoles(...STAFF_ROLES)
  settings(@CurrentUser() user: Principal) {
    return this.maintenance.getSettings(user);
  }

  @Put('settings')
  @RequireRoles(...PLANNING_ROLES)
  @ApiOperation({ summary: 'Labour rate, currency and default parts store of the tenant' })
  saveSettings(@CurrentUser() user: Principal, @ZBody(MaintenanceSettings) body: z.infer<typeof MaintenanceSettings>) {
    return this.maintenance.saveSettings(user, body);
  }
}

/** Preventive maintenance and inspection planning (same capability). */
@ApiTags('maintenance-planning')
@ApiBearerAuth()
@Controller('planning')
@RequireCapability(Capabilities.Maintenance)
@RequireRoles(...STAFF_ROLES)
class PlanningController {
  constructor(@Inject(PlanningService) private readonly planning: PlanningService) {}

  @Get('upcoming')
  @ApiOperation({ summary: 'Preventive and inspection plans due within `days` days, and rounds waiting' })
  upcoming(@CurrentUser() user: Principal, @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number) {
    return this.planning.upcoming(user, Math.min(Math.max(days, 1), 365));
  }

  @Get('pm-plans')
  pmPlans(@CurrentUser() user: Principal) {
    return this.planning.listPmPlans(user);
  }

  @Post('pm-plans')
  @RequireRoles(...PLANNING_ROLES)
  @ApiOperation({ summary: 'Preventive plan: a work order is opened every interval_days, lead_days before it is due' })
  createPm(@CurrentUser() user: Principal, @ZBody(CreatePmPlan) body: z.infer<typeof CreatePmPlan>) {
    return this.planning.createPmPlan(user, body);
  }

  @Patch('pm-plans/:id')
  @RequireRoles(...PLANNING_ROLES)
  setPm(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(SetActive) body: z.infer<typeof SetActive>) {
    return this.planning.setPmActive(user, id, body.active);
  }

  @Post('pm-plans/:id/generate')
  @RequireRoles(...PLANNING_ROLES)
  @ApiOperation({ summary: 'Open the work order for the next due date now' })
  generatePm(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.planning.generatePmNow(user, id);
  }

  @Get('inspection-plans')
  inspectionPlans(@CurrentUser() user: Principal) {
    return this.planning.listInspectionPlans(user);
  }

  @Post('inspection-plans')
  @RequireRoles(...PLANNING_ROLES)
  createInspection(@CurrentUser() user: Principal, @ZBody(CreateInspectionPlan) body: z.infer<typeof CreateInspectionPlan>) {
    return this.planning.createInspectionPlan(user, body);
  }

  @Patch('inspection-plans/:id')
  @RequireRoles(...PLANNING_ROLES)
  setInspection(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(SetActive) body: z.infer<typeof SetActive>) {
    return this.planning.setInspectionActive(user, id, body.active);
  }

  @Post('inspection-plans/:id/generate')
  @RequireRoles(...PLANNING_ROLES)
  generateRound(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.planning.generateRoundNow(user, id);
  }

  @Get('rounds')
  rounds(@CurrentUser() user: Principal, @Query('status') status?: string) {
    return this.planning.listRounds(user, status && ['due', 'completed', 'skipped'].includes(status) ? status : undefined);
  }

  @Get('rounds/:id')
  round(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.planning.getRound(user, id);
  }

  @Post('rounds/:id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record inspection results; each failed item raises a finding request' })
  completeRound(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(CompleteRound) body: z.infer<typeof CompleteRound>) {
    return this.planning.completeRound(user, id, body);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [MaintenanceController, PlanningController],
  providers: [MaintenanceService, PlanningService],
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
