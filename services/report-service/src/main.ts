import { Controller, DefaultValuePipe, Get, HttpCode, Inject, Module, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Capabilities, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, RequireCapability, uuidParam, ZBody } from '@titan/platform';
import type { z } from 'zod';
import { AUTHORS, CreateDefinition, ReportService, UpdateDefinition } from './report.service.js';

interface RawResponse {
  setHeader(k: string, v: string): void;
  end(body: string): void;
}
interface BinaryResponse {
  setHeader(k: string, v: string): void;
  end(body: Buffer): void;
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
@RequireCapability(Capabilities.Reporting)
class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get('datasets')
  @ApiOperation({ summary: 'Datasets a report section can use (from the analytics registry, for the caller)' })
  datasets(@CurrentUser() user: Principal) {
    return this.reports.datasets(user);
  }

  @Get('definitions')
  list(@CurrentUser() user: Principal) {
    return this.reports.listDefinitions(user);
  }

  @Post('definitions')
  @RequireRoles(...AUTHORS)
  @ApiOperation({ summary: 'Define a report: up to 8 sections, each a registered dataset with optional filters; optionally a reminder schedule' })
  create(@CurrentUser() user: Principal, @ZBody(CreateDefinition) body: z.infer<typeof CreateDefinition>) {
    return this.reports.createDefinition(user, body);
  }

  @Get('definitions/:id')
  get(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.reports.getDefinition(user, id);
  }

  @Patch('definitions/:id')
  @RequireRoles(...AUTHORS)
  update(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateDefinition) body: z.infer<typeof UpdateDefinition>) {
    return this.reports.updateDefinition(user, id, body);
  }

  @Post('definitions/:id/generate')
  @HttpCode(201)
  @ApiOperation({ summary: 'Generate the report now, reading each dataset with the caller\'s own access' })
  generate(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.reports.generate(user, id);
  }

  @Get('runs')
  runs(@CurrentUser() user: Principal) {
    return this.reports.listRuns(user);
  }

  @Get('runs/:id')
  run(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.reports.getRun(user, id);
  }

  @Get('runs/:id/csv')
  @ApiOperation({ summary: 'One section of a run as CSV (formula cells neutralised)' })
  async csv(
    @CurrentUser() user: Principal,
    @Param('id', uuidParam) id: string,
    @Query('section', new DefaultValuePipe(0), ParseIntPipe) section: number,
    @Res() res: RawResponse,
  ) {
    const file = await this.reports.csv(user, id, section);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.body);
  }

  @Get('runs/:id/xlsx')
  @ApiOperation({ summary: 'The run as an Excel workbook, one sheet per section (no formulas)' })
  async xlsx(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @Res() res: BinaryResponse) {
    const file = await this.reports.xlsx(user, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.body);
  }

  @Get('runs/:id/pdf')
  @ApiOperation({ summary: 'The run as a PDF document' })
  async pdf(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @Res() res: BinaryResponse) {
    const file = await this.reports.pdf(user, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.body);
  }

  @Get('runs/:id/html')
  @ApiOperation({ summary: 'The run as a printable HTML page (escaped, no scripts)' })
  async html(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @Res() res: RawResponse) {
    const body = await this.reports.html(user, id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(body);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [ReportController],
  providers: [ReportService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN report-service',
  description: 'Report definitions over the registered analytics datasets, generated on request with the caller\'s access, as CSV and printable HTML; due-date reminders.',
  migrations: new URL('../migrations', import.meta.url),
});
