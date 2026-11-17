import { Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { INCIDENT_CLOSER_ROLES, INCIDENT_RESPONDER_ROLES, Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { AddNote, AssignIncident, CreateIncident, IncidentService, ListIncidents } from './incident.service.js';

@ApiTags('incidents')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
class IncidentController {
  constructor(@Inject(IncidentService) private readonly incidents: IncidentService) {}

  @Get('incidents')
  @ApiOperation({ summary: 'List incidents; status=active returns open and acknowledged incidents; filter by category or asset' })
  list(@CurrentUser() user: Principal, @ZQuery(ListIncidents) query: z.infer<typeof ListIncidents>) {
    return this.incidents.list(user, query);
  }

  @Get('incidents/summary')
  summary(@CurrentUser() user: Principal) {
    return this.incidents.summary(user);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Incident categories of the tenant: response workflow, notified role and response targets' })
  categories(@CurrentUser() user: Principal) {
    return this.incidents.listCategories(user);
  }

  @Post('incidents')
  @RequireRoles(...INCIDENT_RESPONDER_ROLES)
  @ApiOperation({ summary: 'Report an incident (manually, or from an inspection, work order, service request or external system)' })
  create(@CurrentUser() user: Principal, @ZBody(CreateIncident) body: z.infer<typeof CreateIncident>) {
    return this.incidents.create(user, body);
  }

  @Get('incidents/:id')
  @ApiOperation({ summary: 'Incident with its timeline' })
  get(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.incidents.get(user, id);
  }

  @Post('incidents/:id/assign')
  @HttpCode(200)
  @RequireRoles(...INCIDENT_RESPONDER_ROLES)
  assign(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AssignIncident) body: z.infer<typeof AssignIncident>) {
    return this.incidents.assign(user, id, body);
  }

  @Post('incidents/:id/notes')
  @RequireRoles(...INCIDENT_RESPONDER_ROLES, Roles.IotOperator, Roles.MaintenanceTechnician)
  addNote(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AddNote) body: z.infer<typeof AddNote>) {
    return this.incidents.addNote(user, id, body);
  }

  @Post('incidents/:id/close')
  @HttpCode(200)
  @RequireRoles(...INCIDENT_CLOSER_ROLES)
  @ApiOperation({ summary: 'Close a resolved incident' })
  close(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.incidents.close(user, id);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [IncidentController],
  providers: [IncidentService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN incident-service',
  description:
    'Incident lifecycle, categories, typed origins, severity, assignment and closure. Acknowledgment and resolution are applied from the response workflow of the incident\'s category.',
  migrations: new URL('../migrations', import.meta.url),
});
