import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaIntegrationService } from './meta.service';
import { SaveMetaConfigDto } from './dto/save-meta-config.dto';

@Controller('whatsapp')
@UseGuards(ActiveCompanyGuard)
export class WhatsappConfigController {
  constructor(private readonly metaIntegrationService: MetaIntegrationService) {}

  @Post('config')
  async saveMetaConfig(
    @Query('companyId') companyId: string,
    @Body() dto: SaveMetaConfigDto,
  ) {
    return this.metaIntegrationService.saveConfig(companyId, dto);
  }

  @Delete('config')
  async deleteMetaConfig(@Query('companyId') companyId: string) {
    return this.metaIntegrationService.deleteConfig(companyId);
  }
}

@Controller('meta')
@UseGuards(ActiveCompanyGuard)
export class MetaStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metaIntegrationService: MetaIntegrationService,
  ) {}

  @Get('status')
  async getConnectionStatus(@Query('companyId') companyId: string) {
    const [company, metaHealth] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: {
          metaPhoneNumberId: true,
          phoneNumber: true,
        },
      }),
      this.metaIntegrationService.getHealthStatus(companyId),
    ]);

    return {
      connected: metaHealth.connected,
      method: metaHealth.connected ? 'meta' : null,
      phoneNumberId: company?.metaPhoneNumberId ?? null,
      phoneNumber: metaHealth.phoneNumber || company?.phoneNumber || null,
      status: metaHealth.connected ? 'CONNECTED' : 'DISCONNECTED',
      updatedAt: metaHealth.dbLastConnected,
    };
  }
}
