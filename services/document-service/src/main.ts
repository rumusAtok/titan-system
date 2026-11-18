import { Controller, Delete, Get, HttpCode, Inject, Module, Param, ParseIntPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { AddLink, AddVersion, CreateDocument, DocumentService, LegalHold, ListDocuments } from './document.service.js';
import { RECORDS_ROLES } from './rules.js';

/**
 * Documents are part of the universal core: no capability is required, but every
 * read is checked against the document's classification.
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller()
class DocumentController {
  constructor(@Inject(DocumentService) private readonly documents: DocumentService) {}

  @Get('retention-classes')
  @ApiOperation({ summary: 'Retention classes and their periods (illustrative defaults, not legal advice)' })
  retentionClasses() {
    return this.documents.retentionClasses();
  }

  @Get('documents')
  @ApiOperation({ summary: 'Documents the caller may read; filter by type, text, or linked record (subject_type + subject_id)' })
  list(@CurrentUser() user: Principal, @ZQuery(ListDocuments) query: z.infer<typeof ListDocuments>) {
    return this.documents.list(user, query);
  }

  @Get('documents/summary')
  @RequireRoles(...STAFF_ROLES)
  summary(@CurrentUser() user: Principal) {
    return this.documents.summary(user);
  }

  @Post('documents')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Create a document with its first version (scanned on upload; at most 5 MB)' })
  create(@CurrentUser() user: Principal, @ZBody(CreateDocument) body: z.infer<typeof CreateDocument>) {
    return this.documents.create(user, body);
  }

  @Get('versions/:id')
  @ApiOperation({ summary: 'Which document (and version number) a version id belongs to' })
  byVersion(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.documents.byVersion(user, id);
  }

  @Get('documents/:id')
  get(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.documents.get(user, id);
  }

  @Post('documents/:id/versions')
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Upload a new version (a draft until submitted)' })
  addVersion(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AddVersion) body: z.infer<typeof AddVersion>) {
    return this.documents.addVersion(user, id, body);
  }

  @Post('documents/:id/versions/:version/submit')
  @HttpCode(200)
  @RequireRoles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Submit a draft for review (document-review workflow), or publish it directly when the document needs no review (records managers)' })
  submit(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.documents.submit(user, id, version);
  }

  @Get('documents/:id/versions/:version/content')
  @ApiOperation({ summary: 'Download a version (always as an attachment)' })
  async content(
    @CurrentUser() user: Principal,
    @Param('id', uuidParam) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Res() res: { setHeader(k: string, v: string): void; end(body: Buffer): void },
  ) {
    const file = await this.documents.content(user, id, version);
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-SHA256', file.sha256);
    res.end(file.content);
  }

  @Post('documents/:id/links')
  @RequireRoles(...STAFF_ROLES)
  addLink(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(AddLink) body: z.infer<typeof AddLink>) {
    return this.documents.addLink(user, id, body);
  }

  @Delete('documents/:id/links/:subjectType/:subjectId')
  @RequireRoles(...STAFF_ROLES)
  removeLink(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @Param('subjectType') subjectType: string, @Param('subjectId') subjectId: string) {
    return this.documents.removeLink(user, id, subjectType, subjectId);
  }

  @Post('documents/:id/legal-hold')
  @HttpCode(200)
  @RequireRoles(...RECORDS_ROLES)
  @ApiOperation({ summary: 'Place or release a legal hold (blocks disposal)' })
  legalHold(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(LegalHold) body: z.infer<typeof LegalHold>) {
    return this.documents.setLegalHold(user, id, body);
  }

  @Post('documents/:id/dispose')
  @HttpCode(200)
  @RequireRoles(...RECORDS_ROLES)
  @ApiOperation({ summary: 'Dispose of a document whose retention has expired and which is not on legal hold. Content is removed; metadata is kept' })
  dispose(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.documents.dispose(user, id);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [DocumentController],
  providers: [DocumentService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN document-service',
  description: 'Controlled documents: versions, malware-scan hook, review through the workflow engine, retention classes, legal hold, disposal and links to records.',
  migrations: new URL('../migrations', import.meta.url),
  // Uploads are base64 in JSON: 5 MB of content is about 6.7 MB of request.
  jsonLimit: '8mb',
});
