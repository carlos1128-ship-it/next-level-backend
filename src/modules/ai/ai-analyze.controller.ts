import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AnalyzeSalesDto } from './dto/analyze-sales.dto';
import { AiService } from './ai.service';

@Controller('ai')
export class AiAnalyzeController {
  constructor(private readonly aiService: AiService) {}

  @Post('analyze')
  async analyze(
    @Body() body: AnalyzeSalesDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.aiService.analyzeSales(body.data, userId);
  }

  @Get('history')
  getHistory(@CurrentUser('sub') userId: string) {
    return this.aiService.getAnalysisHistory(userId);
  }
}
