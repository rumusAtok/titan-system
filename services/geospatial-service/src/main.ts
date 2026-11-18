import { Controller, Get, Inject, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { CreateZone, GeoService, NearbyQuery, PointQuery, UpdateZone } from './geo.service.js';

const ZONE_WRITERS = [Roles.TenantAdmin, Roles.AssetManager, Roles.FacilityManager, Roles.IncidentCommander];

/** Part of the universal core: every staff role may read; a few roles maintain zones. */
@ApiTags('geospatial')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
class GeoController {
  constructor(@Inject(GeoService) private readonly geo: GeoService) {}

  @Get('zones')
  listZones(@CurrentUser() user: Principal) {
    return this.geo.listZones(user);
  }

  @Post('zones')
  @RequireRoles(...ZONE_WRITERS)
  @ApiOperation({ summary: 'Create a zone (GeoJSON Polygon or MultiPolygon, longitude/latitude)' })
  createZone(@CurrentUser() user: Principal, @ZBody(CreateZone) body: z.infer<typeof CreateZone>) {
    return this.geo.createZone(user, body);
  }

  @Patch('zones/:id')
  @RequireRoles(...ZONE_WRITERS)
  updateZone(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateZone) body: z.infer<typeof UpdateZone>) {
    return this.geo.updateZone(user, id, body);
  }

  @Get('zones/:id/features')
  @ApiOperation({ summary: 'Assets, devices, cameras and incidents inside a zone' })
  zoneFeatures(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.geo.zoneFeatures(user, id);
  }

  @Get('locate')
  @ApiOperation({ summary: 'Zones containing a point' })
  locate(@CurrentUser() user: Principal, @ZQuery(PointQuery) query: z.infer<typeof PointQuery>) {
    return this.geo.locate(user, query);
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Located features within a radius of a point, nearest first' })
  nearby(@CurrentUser() user: Principal, @ZQuery(NearbyQuery) query: z.infer<typeof NearbyQuery>) {
    return this.geo.nearby(user, query);
  }

  @Get('layers')
  @ApiOperation({ summary: 'Zones, located features and located incidents as one GeoJSON FeatureCollection' })
  layers(@CurrentUser() user: Principal) {
    return this.geo.layers(user);
  }

  @Post('backfill')
  @RequireRoles(...ZONE_WRITERS)
  @ApiOperation({ summary: 'Refresh the located features from the asset, device and video services (with the caller\'s access)' })
  backfill(@CurrentUser() user: Principal) {
    return this.geo.backfill(user);
  }

  @Get('incidents')
  @ApiOperation({ summary: 'Incidents placed on the map through their asset or device, with the zones they fall in' })
  incidents(@CurrentUser() user: Principal) {
    return this.geo.locatedIncidents(user);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [GeoController],
  providers: [GeoService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN geospatial-service',
  description: 'Zones and geofences, spatial queries over located assets, devices and cameras, and incident-in-zone alerts.',
  migrations: new URL('../migrations', import.meta.url),
  jsonLimit: '2mb',
});
