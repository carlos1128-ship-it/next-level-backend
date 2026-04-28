import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CompanyPersonalizationController } from './company-personalization.controller';
import { CompanyPersonalizationService } from './company-personalization.service';

@Module({
  imports: [PrismaModule],
  controllers: [CompanyPersonalizationController],
  providers: [CompanyPersonalizationService],
  exports: [CompanyPersonalizationService],
})
export class CompanyPersonalizationModule {}
