import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { CAPABILITY_CATALOG, Roles, SUBJECT_TYPES } from '@titan/contracts';
import { ZBody } from '@titan/platform';
import type { z } from 'zod';
import { ActivatePack, ImportPackConfiguration, PacksService, SaveDashboardLayout, UpdatePackConfig } from './packs.service.js';

@ApiTags('industry packs')
@ApiBearerAuth()
@Controller()
export class PacksController {
  constructor(@Inject(PacksService) private readonly packs: PacksService) {}

  // --- catalogue (not tenant data) -------------------------------------------

  @Get('packs/catalog')
  @ApiOperation({ summary: 'Industry packs shipped with the platform, with their versions and contents' })
  catalog() {
    return this.packs.listCatalog();
  }

  @Get('packs/catalog/:id/:version')
  @ApiOperation({ summary: 'Complete manifest of one pack version' })
  manifest(@Param('id') id: string, @Param('version') version: string) {
    return this.packs.getManifest(id, version);
  }

  @Get('platform/capabilities')
  @ApiOperation({ summary: 'Platform layers: core capabilities, switchable business capabilities, registered workflow subject types' })
  capabilities() {
    return { capabilities: CAPABILITY_CATALOG, workflow_subject_types: SUBJECT_TYPES };
  }

  @Post('platform/entitlements/republish')
  @HttpCode(200)
  @RequireRoles(Roles.PlatformAdmin)
  @ApiOperation({ summary: 'Re-announce the entitlements of every tenant (platform administrators only)' })
  republish() {
    return this.packs.republishEntitlements();
  }

  // --- the caller's tenant ------------------------------------------------------

  @Get('packs')
  @ApiOperation({ summary: "The caller's tenant: packs, versions, status and configuration" })
  list(@CurrentUser() user: Principal) {
    return this.packs.listTenantPacks(user);
  }

  @Get('packs/history')
  @RequireRoles(Roles.TenantAdmin, Roles.Auditor)
  @ApiOperation({ summary: 'Every activation, upgrade, reconfiguration and deactivation of the tenant' })
  history(@CurrentUser() user: Principal) {
    return this.packs.history(user);
  }

  @Get('packs/export')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: "Export the tenant's pack activation, versions, configuration and dashboard layouts" })
  export(@CurrentUser() user: Principal) {
    return this.packs.exportConfiguration(user);
  }

  @Post('packs/import')
  @HttpCode(200)
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Restore pack configuration from an export (always into the caller\'s own tenant); supports dry_run' })
  import(@CurrentUser() user: Principal, @ZBody(ImportPackConfiguration) body: z.infer<typeof ImportPackConfiguration>) {
    return this.packs.importConfiguration(user, body);
  }

  @Post('packs/:id/activate')
  @HttpCode(200)
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({
    summary: 'Activate, re-activate or upgrade a pack for the tenant',
    description:
      'Checks pack dependencies and the upgrade path, validates configuration, records the change and announces the templates ' +
      'to install and the new entitlements. Running business processes continue on the definition version they started with.',
  })
  activate(@CurrentUser() user: Principal, @Param('id') id: string, @ZBody(ActivatePack) body: z.infer<typeof ActivatePack>) {
    return this.packs.activate(user, id, body);
  }

  @Post('packs/:id/deactivate')
  @HttpCode(200)
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Deactivate a pack: its capabilities are withdrawn, no business data is deleted' })
  deactivate(@CurrentUser() user: Principal, @Param('id') id: string) {
    return this.packs.deactivate(user, id);
  }

  @Put('packs/:id/config')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: "Change the tenant's configuration of a pack (optimistic concurrency via expected_version)" })
  updateConfig(@CurrentUser() user: Principal, @Param('id') id: string, @ZBody(UpdatePackConfig) body: z.infer<typeof UpdatePackConfig>) {
    return this.packs.updateConfig(user, id, body);
  }

  @Post('packs/:id/resync')
  @HttpCode(200)
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Re-announce the templates of an active pack and the tenant entitlements to all services' })
  resync(@CurrentUser() user: Principal, @Param('id') id: string) {
    return this.packs.resync(user, id);
  }

  @Get('entitlements')
  @ApiOperation({ summary: "The caller's tenant: active capabilities, packs, approved query templates and AI tools" })
  entitlements(@CurrentUser() user: Principal) {
    return this.packs.entitlements(user);
  }

  @Get('workspace')
  @ApiOperation({
    summary: 'Navigation, industry workspaces, dashboards and role templates for the caller',
    description: 'Derived from the active packs and filtered by the caller\'s roles. This shapes the user interface only; every service enforces access itself.',
  })
  workspace(@CurrentUser() user: Principal) {
    return this.packs.workspace(user);
  }

  @Put('workspace/dashboards/:key')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: "Save the tenant's layout of a dashboard: which widgets, in which order" })
  saveLayout(@CurrentUser() user: Principal, @Param('key') key: string, @ZBody(SaveDashboardLayout) body: z.infer<typeof SaveDashboardLayout>) {
    return this.packs.saveDashboardLayout(user, key, body);
  }

  @Delete('workspace/dashboards/:key')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Return a dashboard to the layout defined by its pack' })
  resetLayout(@CurrentUser() user: Principal, @Param('key') key: string) {
    return this.packs.resetDashboardLayout(user, key);
  }
}
