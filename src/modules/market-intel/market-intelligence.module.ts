import { Module } from '@nestjs/common';
import { MarketIntelligenceService } from './market-intelligence.service';
import { MarketIntelligenceController } from './market-intelligence.controller';
import { AlertsModule } from '../alerts/alerts.module';
import { StrategyModule } from '../strategy/strategy.module';

@Module({
  imports: [AlertsModule, StrategyModule],
  controllers: [MarketIntelligenceController],
  providers: [MarketIntelligenceService],
  exports: [MarketIntelligenceService],
})
export class MarketIntelligenceModule {}
