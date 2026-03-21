import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AdminService } from './admin.service';
import { UpdateQuotaDto } from './dto/update-quota.dto';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  getHealth() {
    return this.adminService.getHealth();
  }

  @Get('usage-stats')
  getUsageStats() {
    return this.adminService.getUsageStats();
  }

  @Get('error-logs')
  getErrorLogs() {
    return this.adminService.getErrorLogs();
  }

  @Get('audit-feed')
  getAuditFeed() {
    return this.adminService.getAuditFeed();
  }

  @Get('quotas')
  listQuotas() {
    return this.adminService.listQuotas();
  }

  @Post('quotas/:companyId/reset')
  resetQuota(
    @Param('companyId') companyId: string,
    @Req() req: { user?: { id?: string } },
  ) {
    return this.adminService.resetQuota(companyId, req.user?.id);
  }

  @Patch('quotas/:companyId')
  updateQuota(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateQuotaDto,
    @Req() req: { user?: { id?: string } },
  ) {
    return this.adminService.updateQuota(companyId, dto, req.user?.id);
  }
}
