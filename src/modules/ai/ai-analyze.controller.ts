import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AiService } from './ai.service';

@Controller('ai')
export class AiAnalyzeController {
  constructor(private readonly aiService: AiService) {}

  @UseGuards(AuthGuard('jwt'))
  @Post('analyze')
  async analyze(@Body() body: any, @Req() req: any) {
    return this.aiService.analyzeSales(body.data, req.user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('history')
  getHistory(@Req() req: any) {
    return this.aiService.getAnalysisHistory(req.user.id);
  }
}
