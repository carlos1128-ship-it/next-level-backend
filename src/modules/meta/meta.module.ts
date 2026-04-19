import { Module } from '@nestjs/common';
import { MetaIntegrationService } from './meta.service';
import { WhatsappConfigController, MetaStatusController } from './meta.controller';
import { MetaOAuthService } from './meta-oauth.service';
import { MetaOAuthController } from './meta-oauth.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [
    WhatsappConfigController,
    MetaStatusController,
    MetaOAuthController,
  ],
  providers: [MetaIntegrationService, MetaOAuthService],
  exports: [MetaIntegrationService, MetaOAuthService],
})
export class MetaIntegrationModule {}
