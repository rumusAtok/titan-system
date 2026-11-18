import { Controller, Get, HttpCode, Inject, Module, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type Principal, RequireRoles } from '@titan/authentication';
import { Capabilities, Roles, STAFF_ROLES } from '@titan/contracts';
import { bootstrapService, PlatformModule, RequireCapability, uuidParam, ZBody, ZQuery } from '@titan/platform';
import type { z } from 'zod';
import {
  AdjustStock, BUYERS, CreateItem, CreatePurchaseRequest, CreateSupplier, IssueStock, ListRequests, ProcurementService, ReceiveGoods, REQUESTERS, STORES,
} from './procurement.service.js';
import { Award, CreateCostCentre, CreateRfq, RecordQuotation, SetBudget, SourcingService } from './sourcing.service.js';

@ApiTags('procurement')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
@RequireCapability(Capabilities.Procurement)
class ProcurementController {
  constructor(@Inject(ProcurementService) private readonly procurement: ProcurementService) {}

  @Get('suppliers')
  suppliers(@CurrentUser() user: Principal) {
    return this.procurement.listSuppliers(user);
  }

  @Post('suppliers')
  @RequireRoles(...BUYERS)
  createSupplier(@CurrentUser() user: Principal, @ZBody(CreateSupplier) body: z.infer<typeof CreateSupplier>) {
    return this.procurement.createSupplier(user, body);
  }

  @Get('items')
  @ApiOperation({ summary: 'Stock items with stock on hand per location' })
  items(@CurrentUser() user: Principal) {
    return this.procurement.listItems(user);
  }

  @Post('items')
  @RequireRoles(...BUYERS)
  createItem(@CurrentUser() user: Principal, @ZBody(CreateItem) body: z.infer<typeof CreateItem>) {
    return this.procurement.createItem(user, body);
  }

  @Get('items/:sku/movements')
  movements(@CurrentUser() user: Principal, @Param('sku') sku: string) {
    return this.procurement.movements(user, sku);
  }

  @Post('stock/issue')
  @HttpCode(200)
  @RequireRoles(...STORES)
  @ApiOperation({ summary: 'Issue stock (e.g. to a work order). At or below the reorder level a replenishment request is raised' })
  issue(@CurrentUser() user: Principal, @ZBody(IssueStock) body: z.infer<typeof IssueStock>) {
    return this.procurement.issue(user, body);
  }

  @Post('stock/adjust')
  @HttpCode(200)
  @RequireRoles(...STORES)
  @ApiOperation({ summary: 'Record a stock count; the difference is booked as an adjustment' })
  adjust(@CurrentUser() user: Principal, @ZBody(AdjustStock) body: z.infer<typeof AdjustStock>) {
    return this.procurement.adjust(user, body);
  }

  @Get('purchase-requests')
  requests(@CurrentUser() user: Principal, @ZQuery(ListRequests) query: z.infer<typeof ListRequests>) {
    return this.procurement.listRequests(user, query);
  }

  @Post('purchase-requests')
  @RequireRoles(...REQUESTERS)
  @ApiOperation({ summary: 'Raise a purchase request; it goes to the purchase-approval workflow, and approval issues a purchase order' })
  createRequest(@CurrentUser() user: Principal, @ZBody(CreatePurchaseRequest) body: z.infer<typeof CreatePurchaseRequest>) {
    return this.procurement.createRequest(user, body);
  }

  @Get('purchase-requests/:id')
  getRequest(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.procurement.getRequest(user, id);
  }

  @Post('purchase-requests/:id/cancel')
  @HttpCode(200)
  cancelRequest(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.procurement.cancelRequest(user, id);
  }

  @Get('purchase-orders')
  orders(@CurrentUser() user: Principal) {
    return this.procurement.listOrders(user);
  }

  @Get('purchase-orders/:id')
  getOrder(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.procurement.getOrder(user, id);
  }

  @Post('purchase-orders/:id/receive')
  @HttpCode(200)
  @RequireRoles(...STORES)
  @ApiOperation({ summary: 'Record a goods receipt (partial or complete); stock increases at the delivery location' })
  receive(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(ReceiveGoods) body: z.infer<typeof ReceiveGoods>) {
    return this.procurement.receive(user, id, body);
  }

  @Get('summary')
  summary(@CurrentUser() user: Principal) {
    return this.procurement.summary(user);
  }
}

@ApiTags('procurement-sourcing')
@ApiBearerAuth()
@Controller()
@RequireRoles(...STAFF_ROLES)
@RequireCapability(Capabilities.Procurement)
class SourcingController {
  constructor(@Inject(SourcingService) private readonly sourcing: SourcingService) {}

  @Get('cost-centres')
  @ApiOperation({ summary: 'Cost centres with this year\'s budget, committed spend and what is left' })
  costCentres(@CurrentUser() user: Principal) {
    return this.sourcing.listCostCentres(user);
  }

  @Post('cost-centres')
  @RequireRoles(...BUYERS)
  createCostCentre(@CurrentUser() user: Principal, @ZBody(CreateCostCentre) body: z.infer<typeof CreateCostCentre>) {
    return this.sourcing.createCostCentre(user, body);
  }

  @Put('cost-centres/:code/budget')
  @RequireRoles(Roles.TenantAdmin, Roles.DepartmentHead)
  @ApiOperation({ summary: 'Set the budget of a cost centre for a year (tenant administrator or budget holder)' })
  setBudget(@CurrentUser() user: Principal, @Param('code') code: string, @ZBody(SetBudget) body: z.infer<typeof SetBudget>) {
    return this.sourcing.setBudget(user, code, body);
  }

  @Get('rfqs')
  rfqs(@CurrentUser() user: Principal) {
    return this.sourcing.listRfqs(user);
  }

  @Post('rfqs')
  @RequireRoles(...BUYERS)
  @ApiOperation({ summary: 'Request for quotation: items, quantities and invited suppliers (nobody is contacted by TITAN)' })
  createRfq(@CurrentUser() user: Principal, @ZBody(CreateRfq) body: z.infer<typeof CreateRfq>) {
    return this.sourcing.createRfq(user, body);
  }

  @Get('rfqs/:id')
  @ApiOperation({ summary: 'A request for quotation with its quotations, cheapest first' })
  rfq(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.sourcing.getRfq(user, id);
  }

  @Post('rfqs/:id/quotations')
  @RequireRoles(...BUYERS)
  @ApiOperation({ summary: 'Record a quotation received from an invited supplier' })
  quote(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(RecordQuotation) body: z.infer<typeof RecordQuotation>) {
    return this.sourcing.recordQuotation(user, id, body);
  }

  @Post('rfqs/:id/award')
  @HttpCode(200)
  @RequireRoles(...BUYERS)
  @ApiOperation({ summary: 'Award a quotation: it becomes a purchase request (normal approval); a non-lowest award needs a reason' })
  award(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string, @ZBody(Award) body: z.infer<typeof Award>) {
    return this.sourcing.award(user, id, body);
  }

  @Post('rfqs/:id/cancel')
  @HttpCode(200)
  @RequireRoles(...BUYERS)
  cancelRfq(@CurrentUser() user: Principal, @Param('id', uuidParam) id: string) {
    return this.sourcing.cancelRfq(user, id);
  }
}

@Module({
  imports: [PlatformModule.forRoot()],
  controllers: [ProcurementController, SourcingController],
  providers: [ProcurementService, SourcingService],
})
export class AppModule {}

await bootstrapService({
  module: AppModule,
  title: 'TITAN procurement-service',
  description: 'Suppliers, stock items and levels, purchase requests with approval, purchase orders (internal records), goods receipts, stock issues and replenishment.',
  migrations: new URL('../migrations', import.meta.url),
});
