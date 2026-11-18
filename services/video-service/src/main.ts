import { Controller, Get, HttpCode, Inject, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Capabilities, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, RequireCapability, uuidParam, ZBody } from '@titan/platform';
import type { z } from 'zod';
import {
  ChangeStatus, CreateMarker, LegalHold, OPERATORS, RegisterCamera, RegisterRecording, SESSION_AUDITORS, StartSession, UpdateCamera, VIEWERS, VideoService,
} from './video.service.js';

@ApiTags('video')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
@RequireCapability(Capabilities.Video)
class VideoController {
  constructor(@Inject(VideoService) private readonly video: VideoService) {}

  @Get('cameras')
  @ApiOperation({ summary: 'Camera register (stream URLs are not listed)' })
  cameras(@CurrentUser() user: Principal) {
    return this.video.listCameras(user);
  }

  @Post('cameras')
  @RequireRoles(...OPERATORS)
  register(@CurrentUser() user: Principal, @ZBody(RegisterCamera) body: z.infer<typeof RegisterCamera>) {
    return this.video.register(user, body);
  }

  @Get('cameras/:id')
  @ApiOperation({ summary: 'A camera with its recordings, markers and recent viewing sessions' })
  camera(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.video.getCamera(user, id);
  }

  @Patch('cameras/:id')
  @RequireRoles(...OPERATORS)
  @ApiOperation({ summary: 'Change a camera: name, location, stream URL (no credentials), retention, privacy masking' })
  update(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(UpdateCamera) body: z.infer<typeof UpdateCamera>) {
    return this.video.updateCamera(user, id, body);
  }

  @Post('cameras/:id/status')
  @HttpCode(200)
  @RequireRoles(...OPERATORS)
  status(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(ChangeStatus) body: z.infer<typeof ChangeStatus>) {
    return this.video.changeStatus(user, id, body);
  }

  @Post('cameras/:id/sessions')
  @RequireRoles(...VIEWERS)
  @ApiOperation({ summary: 'Open a viewing session: states a purpose, is logged and audited, and returns the stream URL for the viewer\'s player' })
  startSession(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(StartSession) body: z.infer<typeof StartSession>) {
    return this.video.startSession(user, id, body);
  }

  @Post('sessions/:id/end')
  @HttpCode(200)
  @RequireRoles(...VIEWERS)
  endSession(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.video.endSession(user, id);
  }

  @Get('sessions')
  @RequireRoles(...SESSION_AUDITORS)
  @ApiOperation({ summary: 'Viewing log: who opened which camera, when and why' })
  sessions(@CurrentUser() user: Principal) {
    return this.video.sessions(user);
  }

  @Post('cameras/:id/recordings')
  @RequireRoles(...OPERATORS)
  @ApiOperation({ summary: 'Register a recording segment held by the external video management system (metadata only)' })
  recording(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(RegisterRecording) body: z.infer<typeof RegisterRecording>) {
    return this.video.registerRecording(user, id, body);
  }

  @Post('recordings/:id/legal-hold')
  @HttpCode(200)
  @RequireRoles(...OPERATORS)
  legalHold(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(LegalHold) body: z.infer<typeof LegalHold>) {
    return this.video.setLegalHold(user, id, body.legal_hold);
  }

  @Post('cameras/:id/markers')
  @RequireRoles(...VIEWERS)
  @ApiOperation({ summary: 'Mark a moment (optionally in a recording, optionally for an incident); the incident timeline records it' })
  marker(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(CreateMarker) body: z.infer<typeof CreateMarker>) {
    return this.video.createMarker(user, id, body);
  }

  @Get('incidents')
  @ApiOperation({ summary: 'Recent incidents a marker can refer to' })
  incidents(@CurrentUser() user: Principal) {
    return this.video.incidents(user);
  }

  @Get('incidents/:id/markers')
  incidentMarkers(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.video.incidentMarkers(user, id);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [VideoController],
  providers: [VideoService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN video-service',
  description: 'Camera register, audited viewing sessions, recording metadata (clips stay in the external VMS) with retention and legal hold, and incident markers. No video is stored or analysed.',
  migrations: new URL('../migrations', import.meta.url),
});
