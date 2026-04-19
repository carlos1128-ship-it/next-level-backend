import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WhatsappMessageProcessStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformQueueService } from '../queue/platform-queue.service';

@Injectable()
export class WhatsappRuntimeRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappRuntimeRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformQueue: PlatformQueueService,
  ) {}

  async onModuleInit() {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);

    await this.prisma.whatsappMessageEvent.updateMany({
      where: {
        status: WhatsappMessageProcessStatus.PROCESSING,
        updatedAt: { lt: staleBefore },
      },
      data: {
        status: WhatsappMessageProcessStatus.PENDING,
        errorMessage: 'Processamento recuperado apos restart ou timeout',
      },
    }).catch(() => undefined);

    const pending = await this.prisma.whatsappMessageEvent.findMany({
      where: {
        status: {
          in: [
            WhatsappMessageProcessStatus.PENDING,
            WhatsappMessageProcessStatus.FAILED,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        companyId: true,
      },
    }).catch(() => []);

    for (const item of pending) {
      await this.platformQueue.enqueueWhatsappMessage({
        messageEventId: item.id,
        companyId: item.companyId,
      });
    }

    if (pending.length) {
      this.logger.log(`Recuperacao do runtime WhatsApp reenfileirou ${pending.length} evento(s).`);
    }
  }
}
