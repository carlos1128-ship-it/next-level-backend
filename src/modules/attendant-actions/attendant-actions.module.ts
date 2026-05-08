import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AttendantActionService } from './attendant-action.service';
import { AttendantContextService } from './attendant-context.service';
import { AttendantDataExtractionService } from './attendant-data-extraction.service';
import { AttendantIntentService } from './attendant-intent.service';
import { AttendantInternalController } from './attendant-internal.controller';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [AttendantInternalController],
  providers: [
    AttendantActionService,
    AttendantContextService,
    AttendantDataExtractionService,
    AttendantIntentService,
  ],
  exports: [
    AttendantActionService,
    AttendantContextService,
    AttendantDataExtractionService,
    AttendantIntentService,
  ],
})
export class AttendantActionsModule {}
