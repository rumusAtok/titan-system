import { Controller, Get, Inject, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { MeasurementsQuery, SeriesQuery, TelemetryService } from './telemetry.service.js';

@ApiTags('telemetry')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
class TelemetryController {
  constructor(@Inject(TelemetryService) private readonly telemetry: TelemetryService) {}

  @Get('latest')
  @ApiOperation({ summary: 'Latest reading per device and sensor' })
  latest(@CurrentUser() user: Principal) {
    return this.telemetry.latest(user);
  }

  @Get('measurements')
  @ApiOperation({ summary: 'Raw readings with quality flags and observed/received/processed timestamps' })
  measurements(@CurrentUser() user: Principal, @ZQuery(MeasurementsQuery) query: z.infer<typeof MeasurementsQuery>) {
    return this.telemetry.measurements(user, query);
  }

  @Get('series')
  @ApiOperation({ summary: 'Down-sampled series (avg/min/max per bucket) for charts' })
  series(@CurrentUser() user: Principal, @ZQuery(SeriesQuery) query: z.infer<typeof SeriesQuery>) {
    return this.telemetry.series(user, query);
  }

  @Get('ingest/stats')
  @ApiOperation({ summary: 'Ingestion health for the last hour: quality mix, latency, rejections' })
  stats(@CurrentUser() user: Principal) {
    return this.telemetry.ingestStats(user);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [TelemetryController],
  providers: [TelemetryService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN telemetry-service',
  description: 'Measurement ingestion over MQTT, validation, normalisation and partitioned time-series persistence.',
  migrations: new URL('../migrations', import.meta.url),
});
