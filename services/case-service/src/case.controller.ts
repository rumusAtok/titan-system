import { Controller, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles } from '@titan/contracts';
import { uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { CaseService, CreateCase, CreateForm, ListCases, UpdateCase, UploadAttachment } from './case.service.js';

@ApiTags('cases')
@ApiBearerAuth()
@Controller()
export class CaseController {
  constructor(@Inject(CaseService) private readonly cases: CaseService) {}

  @Get('forms')
  @ApiOperation({ summary: 'Active application forms' })
  listForms(@CurrentUser() user: Principal) {
    return this.cases.listForms(user);
  }

  @Post('forms')
  @RequireRoles(Roles.TenantAdmin)
  @ApiOperation({ summary: 'Publish a new version of a form' })
  createForm(@CurrentUser() user: Principal, @ZBody(CreateForm) body: z.infer<typeof CreateForm>) {
    return this.cases.createForm(user, body);
  }

  @Get('cases')
  @ApiOperation({ summary: 'List cases. Applicants always see only their own.' })
  list(@CurrentUser() user: Principal, @ZQuery(ListCases) query: z.infer<typeof ListCases>) {
    return this.cases.list(user, query);
  }

  @Post('cases')
  @ApiOperation({ summary: 'Create a draft case' })
  create(@CurrentUser() user: Principal, @ZBody(CreateCase) body: z.infer<typeof CreateCase>) {
    return this.cases.create(user, body);
  }

  @Get('cases/track/:reference')
  @ApiOperation({ summary: 'Applicant status tracking by reference number' })
  track(@CurrentUser() user: Principal, @Param('reference') reference: string) {
    return this.cases.track(user, reference);
  }

  @Get('cases/:id')
  get(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.cases.get(user, id);
  }

  @Patch('cases/:id')
  @ApiOperation({ summary: 'Edit a draft or returned case (optimistic concurrency via expected_version)' })
  update(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateCase) body: z.infer<typeof UpdateCase>) {
    return this.cases.update(user, id, body);
  }

  @Post('cases/:id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit a draft, or resubmit a returned case' })
  submit(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.cases.submit(user, id);
  }

  @Post('cases/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.cases.cancel(user, id);
  }

  @Get('cases/:id/history')
  history(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.cases.history(user, id);
  }

  @Post('cases/:id/attachments')
  @ApiOperation({ summary: 'Attach a file (PDF, PNG, JPEG or plain text, at most 2 MB)' })
  addAttachment(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UploadAttachment) body: z.infer<typeof UploadAttachment>) {
    return this.cases.addAttachment(user, id, body);
  }

  @Get('cases/:id/attachments/:attachmentId/download')
  async download(
    @CurrentUser() user: Principal,
    @Param('id', uuidParam) id: string,
    @Param('attachmentId', uuidParam) attachmentId: string,
    @Res() res: { setHeader(k: string, v: string): void; end(body: Buffer): void },
  ) {
    const file = await this.cases.attachmentContent(user, id, attachmentId);
    res.setHeader('Content-Type', file.content_type);
    // Always download, never render inline, and forbid content sniffing.
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.content);
  }
}
