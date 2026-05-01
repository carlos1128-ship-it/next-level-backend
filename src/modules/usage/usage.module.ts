import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AIUsageController } from './ai-usage.controller';
import { AIUsageService } from './ai-usage.service';

@Module({
  imports: [PrismaModule],
  controllers: [AIUsageController],
  providers: [AIUsageService],
  exports: [AIUsageService],
})
export class UsageModule {}
