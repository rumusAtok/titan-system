import { Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Roles } from '@titan/contracts';
import { bootstrapService, PlatformModule, uuidParam, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import { ListDeliveries, ListNotifications, NotificationService } from './notification.service.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller()
class NotificationController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  @Get('notifications')
  @ApiOperation({ summary: "The caller's notifications (addressed to them or to one of their roles)" })
  list(@CurrentUser() user: Principal, @ZQuery(ListNotifications) query: z.infer<typeof ListNotifications>) {
    return this.notifications.listMine(user, query);
  }

  @Get('notifications/unread-count')
  unread(@CurrentUser() user: Principal) {
    return this.notifications.unreadCount(user);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  markRead(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.notifications.markRead(user, id);
  }

  @Get('deliveries')
  @RequireRoles(Roles.TenantAdmin, Roles.Auditor)
  @ApiOperation({ summary: 'Delivery status of all notifications of the tenant' })
  deliveries(@CurrentUser() user: Principal, @ZQuery(ListDeliveries) query: z.infer<typeof ListDeliveries>) {
    return this.notifications.listDeliveries(user, query);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [NotificationController],
  providers: [NotificationService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN notification-service',
  description: 'In-app notifications, e-mail adapters, delivery status and retry scheduling.',
  migrations: new URL('../migrations', import.meta.url),
});
