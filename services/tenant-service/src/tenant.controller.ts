import { Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles } from '@titan/contracts';
import { ZBody } from '@titan/platform';
import type { z } from 'zod';
import { CreateDepartment, CreateJurisdiction, CreateTenant, TenantService, UpdateConfig, UpsertMembership } from './tenant.service.js';

/** Descriptions shown in the administration UI. Role assignment itself is done in Keycloak. */
const ROLE_CATALOG = [
  { role: Roles.Applicant, scope: 'tenant', description: 'Submits and tracks applications' },
  { role: Roles.ValidationOfficer, scope: 'tenant', description: 'Checks applications for completeness' },
  { role: Roles.TechnicalOfficer, scope: 'tenant', description: 'Performs technical assessment' },
  { role: Roles.DepartmentHead, scope: 'tenant', description: 'Endorses applications for the department' },
  { role: Roles.FinalApprover, scope: 'tenant', description: 'Issues the final decision' },
  { role: Roles.DutyOfficer, scope: 'tenant', description: 'Acknowledges and triages incidents' },
  { role: Roles.IncidentCommander, scope: 'tenant', description: 'Directs response and resolves incidents' },
  { role: Roles.AssetManager, scope: 'tenant', description: 'Maintains the asset register' },
  { role: Roles.IotOperator, scope: 'tenant', description: 'Manages devices, alert rules and telemetry' },
  { role: Roles.Analyst, scope: 'tenant', description: 'Reads analytical datasets and reports' },
  { role: Roles.Auditor, scope: 'tenant', description: 'Reads audit records' },
  { role: Roles.TenantAdmin, scope: 'tenant', description: 'Administers the tenant' },
  { role: Roles.DrOperator, scope: 'platform', description: 'Operates disaster-recovery controls' },
  { role: Roles.PlatformAdmin, scope: 'platform', description: 'Administers the platform across tenants' },
];

@ApiTags('tenants')
@ApiBearerAuth()
@Controller()
export class TenantController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Get('tenants')
  @RequireRoles(Roles.PlatformAdmin)
  @ApiOperation({ summary: 'List all tenants (platform administrators only)' })
  list() {
    return this.tenants.listTenants();
  }

  @Post('tenants')
  @RequireRoles(Roles.PlatformAdmin)
  @ApiOperation({ summary: 'Create a tenant (platform administrators only)' })
  create(@ZBody(CreateTenant) body: z.infer<typeof CreateTenant>) {
    return this.tenants.createTenant(body);
  }

  @Get('tenants/current')
  @ApiOperation({ summary: "The caller's own tenant and its configuration" })
  current(@CurrentUser() user: Principal) {
    return this.tenants.currentTenant(user);
  }

  @Put('tenants/current/config')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Replace tenant configuration (optimistic concurrency via expected_version)' })
  updateConfig(@CurrentUser() user: Principal, @ZBody(UpdateConfig) body: z.infer<typeof UpdateConfig>) {
    return this.tenants.updateConfig(user, body);
  }

  @Get('departments')
  listDepartments(@CurrentUser() user: Principal) {
    return this.tenants.listDepartments(user);
  }

  @Post('departments')
  @RequireRoles(Roles.TenantAdmin)
  createDepartment(@CurrentUser() user: Principal, @ZBody(CreateDepartment) body: z.infer<typeof CreateDepartment>) {
    return this.tenants.createDepartment(user, body);
  }

  @Get('jurisdictions')
  listJurisdictions(@CurrentUser() user: Principal) {
    return this.tenants.listJurisdictions(user);
  }

  @Post('jurisdictions')
  @RequireRoles(Roles.TenantAdmin)
  createJurisdiction(@CurrentUser() user: Principal, @ZBody(CreateJurisdiction) body: z.infer<typeof CreateJurisdiction>) {
    return this.tenants.createJurisdiction(user, body);
  }

  @Get('memberships')
  @RequireRoles(Roles.TenantAdmin)
  listMemberships(@CurrentUser() user: Principal) {
    return this.tenants.listMemberships(user);
  }

  @Get('memberships/me')
  async myMembership(@CurrentUser() user: Principal) {
    return {
      user_id: user.userId,
      username: user.username,
      tenant_id: user.tenantId,
      roles: user.roles,
      department: user.department,
      membership: await this.tenants.myMembership(user),
    };
  }

  @Put('memberships/:userId')
  @RequireRoles(Roles.TenantAdmin)
  upsertMembership(@CurrentUser() user: Principal, @Param('userId') userId: string, @ZBody(UpsertMembership) body: z.infer<typeof UpsertMembership>) {
    return this.tenants.upsertMembership(user, userId, body);
  }

  @Get('roles')
  @ApiOperation({ summary: 'Catalogue of platform roles' })
  roles() {
    return ROLE_CATALOG;
  }
}
