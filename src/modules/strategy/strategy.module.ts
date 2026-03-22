import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { StrategyController } from './strategy.controller';
import { AiModule } from '../ai/ai.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [IntegrationsModule, AiModule],
  controllers: [StrategyController],
  providers: [StrategyService],
  exports: [StrategyService, IntegrationsModule],
})
export class StrategyModule {}
