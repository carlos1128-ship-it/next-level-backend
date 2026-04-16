import { Module } from '@nestjs/common';
import { MetaIntegrationService } from './meta.service';
import { MetaIntegrationController } from './meta.controller';

@Module({
  controllers: [MetaIntegrationController],
  providers: [MetaIntegrationService],
  exports: [MetaIntegrationService],
})
export class MetaIntegrationModule {}
