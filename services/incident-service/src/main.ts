import { Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { AddNote, AssignIncident, CreateIncident, IncidentService, ListIncidents } from './incident.service.js';

const RESPONDERS = [Roles.DutyOfficer, Roles.IncidentCommander];

@ApiTags('incidents')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
class IncidentController {
  constructor(@Inject(IncidentService) private readonly incidents: IncidentService) {}

  @Get('incidents')
  @ApiOperation({ summary: 'List incidents; status=active returns open and acknowledged incidents' })
  list(@CurrentUser() user: Principal, @ZQuery(ListIncidents) query: z.infer<typeof ListIncidents>) {
    return this.incidents.list(user, query);
  }

  @Get('incidents/summary')
  summary(@CurrentUser() user: Principal) {
    return this.incidents.summary(user);
  }

  @Post('incidents')
  @RequireRoles(...RESPONDERS)
  @ApiOperation({ summary: 'Report an incident manually' })
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
  @RequireRoles(...RESPONDERS)
  assign(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AssignIncident) body: z.infer<typeof AssignIncident>) {
    return this.incidents.assign(user, id, body);
  }

  @Post('incidents/:id/notes')
  @RequireRoles(...RESPONDERS, Roles.IotOperator)
  addNote(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AddNote) body: z.infer<typeof AddNote>) {
    return this.incidents.addNote(user, id, body);
  }

  @Post('incidents/:id/close')
  @HttpCode(200)
  @RequireRoles(Roles.IncidentCommander)
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
    'Incident lifecycle, severity, assignment and closure. Acknowledgment and resolution are applied from the incident-response workflow.',
  migrations: new URL('../migrations', import.meta.url),
});
