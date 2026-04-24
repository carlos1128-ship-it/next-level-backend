import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';

@Injectable()
export class WhatsappAgentConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, description: true, sector: true, segment: true },
    });

    return this.prisma.agentConfig.upsert({
      where: { companyId },
      update: {},
      create: {
        companyId,
        agentName: 'Atendente Next Level',
        companyDescription:
          company?.description ||
          [company?.name, company?.sector, company?.segment].filter(Boolean).join(' - '),
        welcomeMessage: 'Oi! Sou o atendimento da Next Level. Como posso ajudar?',
        systemPrompt:
          'Voce responde com clareza, nao inventa informacoes e transfere para humano quando necessario.',
        toneOfVoice: 'consultivo',
        internetSearchEnabled: false,
        isEnabled: false,
        pauseForHuman: true,
        speechToTextEnabled: false,
        imageUnderstandingEnabled: false,
        splitRepliesEnabled: false,
        messageBufferEnabled: true,
        debounceSeconds: 3,
        maxContextMessages: 20,
        modelProvider: 'openai',
        modelName: 'gpt-4o-mini',
      },
    });
  }

  async update(companyId: string, dto: UpdateAgentConfigDto) {
    await this.get(companyId);

    return this.prisma.agentConfig.update({
      where: { companyId },
      data: {
        agentName: dto.agentName?.trim(),
        companyDescription: dto.companyDescription,
        welcomeMessage: dto.welcomeMessage,
        systemPrompt: dto.systemPrompt,
        toneOfVoice: dto.toneOfVoice?.trim(),
        internetSearchEnabled: dto.internetSearchEnabled,
        isEnabled: dto.isEnabled,
        pauseForHuman: dto.pauseForHuman,
        speechToTextEnabled: dto.speechToTextEnabled ?? dto.speechToText,
        imageUnderstandingEnabled: dto.imageUnderstandingEnabled ?? dto.imageUnderstanding,
        splitRepliesEnabled: dto.splitRepliesEnabled,
        messageBufferEnabled: dto.messageBufferEnabled,
        debounceSeconds: dto.debounceSeconds,
        maxContextMessages: dto.maxContextMessages,
        modelProvider: dto.modelProvider?.trim(),
        modelName: dto.modelName?.trim(),
      },
    });
  }
}
