import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChatRequestDto } from './dto/chat-request.dto';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequirePlan } from '../billing/decorators/require-plan.decorator';

@Controller('chat')
@UseGuards(JwtAuthGuard)
@RequirePlan('COMMON')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@CurrentUser('sub') userId: string, @Body() dto: ChatRequestDto) {
    return this.chatService.chat(userId, dto);
  }
}
