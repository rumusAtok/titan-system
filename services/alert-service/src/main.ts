import { Controller, Get, HttpCode, Inject, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { AlertService, CreateRule, ListAlerts, UpdateRule } from './alert.service.js';

const RULE_WRITERS = [Roles.IotOperator, Roles.TenantAdmin];
const RESPONDERS = [Roles.DutyOfficer, Roles.IncidentCommander, Roles.IotOperator];

@ApiTags('alerts')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
class AlertController {
  constructor(@Inject(AlertService) private readonly alerts: AlertService) {}

  @Get('rules')
  listRules(@CurrentUser() user: Principal) {
    return this.alerts.listRules(user);
  }

  @Post('rules')
  @RequireRoles(...RULE_WRITERS)
  @ApiOperation({ summary: 'Create a threshold rule' })
  createRule(@CurrentUser() user: Principal, @ZBody(CreateRule) body: z.infer<typeof CreateRule>) {
    return this.alerts.createRule(user, body);
  }

  @Patch('rules/:id')
  @RequireRoles(...RULE_WRITERS)
  updateRule(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateRule) body: z.infer<typeof UpdateRule>) {
    return this.alerts.updateRule(user, id, body);
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Alarm history; status=open returns active and acknowledged alarms' })
  listAlerts(@CurrentUser() user: Principal, @ZQuery(ListAlerts) query: z.infer<typeof ListAlerts>) {
    return this.alerts.listAlerts(user, query);
  }

  @Get('alerts/summary')
  summary(@CurrentUser() user: Principal) {
    return this.alerts.summary(user);
  }

  @Get('alerts/:id')
  getAlert(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.alerts.getAlert(user, id);
  }

  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  @RequireRoles(...RESPONDERS)
  acknowledge(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.alerts.acknowledge(user, id);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [AlertController],
  providers: [AlertService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN alert-service',
  description: 'Threshold rules, alarm generation, deduplication, escalation and alert acknowledgment.',
  migrations: new URL('../migrations', import.meta.url),
});
