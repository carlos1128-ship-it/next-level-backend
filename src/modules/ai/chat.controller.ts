import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChatRequestDto } from './dto/chat-request.dto';
import { ChatService } from './chat.service';
import { ActiveCompanyGuard } from '../../common/guards/active-company.guard';

@Controller('chat')
@UseGuards(ActiveCompanyGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@CurrentUser('sub') userId: string, @Body() dto: ChatRequestDto) {
    return this.chatService.chat(userId, dto);
  }
}
