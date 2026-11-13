import { Controller, Get, HttpCode, Inject, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { AssetService, ChangeStatus, CreateAsset, CreateCategory, ListAssets, RecordMaintenance, UpdateAsset } from './asset.service.js';

const WRITERS = [Roles.AssetManager, Roles.TenantAdmin];

@ApiTags('assets')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
class AssetController {
  constructor(@Inject(AssetService) private readonly assets: AssetService) {}

  @Get('categories')
  listCategories(@CurrentUser() user: Principal) {
    return this.assets.listCategories(user);
  }

  @Post('categories')
  @RequireRoles(...WRITERS)
  createCategory(@CurrentUser() user: Principal, @ZBody(CreateCategory) body: z.infer<typeof CreateCategory>) {
    return this.assets.createCategory(user, body);
  }

  @Get('assets')
  list(@CurrentUser() user: Principal, @ZQuery(ListAssets) query: z.infer<typeof ListAssets>) {
    return this.assets.list(user, query);
  }

  @Get('assets/summary')
  @ApiOperation({ summary: 'Counts by lifecycle status, condition and maintenance position' })
  summary(@CurrentUser() user: Principal) {
    return this.assets.summary(user);
  }

  @Post('assets')
  @RequireRoles(...WRITERS)
  create(@CurrentUser() user: Principal, @ZBody(CreateAsset) body: z.infer<typeof CreateAsset>) {
    return this.assets.create(user, body);
  }

  @Get('assets/:id')
  @ApiOperation({ summary: 'Asset with its category, hierarchy (ancestors and children) and status history' })
  get(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.assets.get(user, id);
  }

  @Patch('assets/:id')
  @RequireRoles(...WRITERS)
  update(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateAsset) body: z.infer<typeof UpdateAsset>) {
    return this.assets.update(user, id, body);
  }

  @Post('assets/:id/status')
  @HttpCode(200)
  @RequireRoles(...WRITERS)
  @ApiOperation({ summary: 'Move the asset through its lifecycle (planned, active, under_maintenance, retired)' })
  changeStatus(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(ChangeStatus) body: z.infer<typeof ChangeStatus>) {
    return this.assets.changeStatus(user, id, body);
  }

  @Post('assets/:id/maintenance')
  @HttpCode(200)
  @RequireRoles(...WRITERS)
  recordMaintenance(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(RecordMaintenance) body: z.infer<typeof RecordMaintenance>) {
    return this.assets.recordMaintenance(user, id, body);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [AssetController],
  providers: [AssetService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN asset-service',
  description: 'Infrastructure assets, categories, locations, asset hierarchy and lifecycle.',
  migrations: new URL('../migrations', import.meta.url),
});
