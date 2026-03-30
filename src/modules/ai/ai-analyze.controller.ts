import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiService } from './ai.service';

@Controller('ai')
export class AiAnalyzeController {
  constructor(private readonly aiService: AiService) {}

  @Post('analyze')
  async analyze(
    @Body() body: Record<string, unknown>,
    @CurrentUser('sub') userId: string,
  ) {
    const payload = this.resolvePayload(body);
    return this.aiService.analyzeSales(payload, userId);
  }

  @Get('history')
  getHistory(@CurrentUser('sub') userId: string) {
    return this.aiService.getAnalysisHistory(userId);
  }

  private resolvePayload(body: Record<string, unknown>): Record<string, unknown> {
    const nested = body?.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body;
    }
    return {};
  }
}
