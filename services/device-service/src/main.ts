import { Controller, Get, HttpCode, Inject, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Capabilities, Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, RequireCapability, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { CreateProfile, DeviceService, ListDevices, RegisterDevice, UpdateConfig } from './device.service.js';

const WRITERS = [Roles.IotOperator, Roles.TenantAdmin];

@ApiTags('devices')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
@RequireCapability(Capabilities.Iot)
class DeviceController {
  constructor(@Inject(DeviceService) private readonly devices: DeviceService) {}

  @Get('sensor-profiles')
  @ApiOperation({ summary: 'Sensor profiles: kinds of device and the metrics (kind, unit, plausible range) each reports' })
  listProfiles(@CurrentUser() user: Principal) {
    return this.devices.listProfiles(user);
  }

  @Post('sensor-profiles')
  @RequireRoles(...WRITERS)
  createProfile(@CurrentUser() user: Principal, @ZBody(CreateProfile) body: z.infer<typeof CreateProfile>) {
    return this.devices.createProfile(user, body);
  }

  @Get('metric-types')
  @ApiOperation({ summary: 'Every metric kind and unit the tenant has registered, from profiles and devices' })
  metricTypes(@CurrentUser() user: Principal) {
    return this.devices.metricTypes(user);
  }

  @Get('devices')
  list(@CurrentUser() user: Principal, @ZQuery(ListDevices) query: z.infer<typeof ListDevices>) {
    return this.devices.list(user, query);
  }

  @Get('devices/summary')
  @ApiOperation({ summary: 'Device counts by status and current availability' })
  summary(@CurrentUser() user: Principal) {
    return this.devices.summary(user);
  }

  @Post('devices')
  @RequireRoles(...WRITERS)
  @ApiOperation({ summary: 'Register a device from a sensor profile, or with an explicit device type and sensors' })
  register(@CurrentUser() user: Principal, @ZBody(RegisterDevice) body: z.infer<typeof RegisterDevice>) {
    return this.devices.register(user, body);
  }

  @Get('devices/:id')
  get(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.devices.get(user, id);
  }

  @Patch('devices/:id/config')
  @RequireRoles(...WRITERS)
  updateConfig(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateConfig) body: z.infer<typeof UpdateConfig>) {
    return this.devices.updateConfig(user, id, body);
  }

  @Post('devices/:id/decommission')
  @HttpCode(200)
  @RequireRoles(...WRITERS)
  decommission(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.devices.decommission(user, id);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [DeviceController],
  providers: [DeviceService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN device-service',
  description: 'IoT device registry, sensor definitions, device status and configuration.',
  migrations: new URL('../migrations', import.meta.url),
});
