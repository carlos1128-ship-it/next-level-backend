import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AttendantContextService {
  constructor(private readonly prisma: PrismaService) {}

  async buildCompanyActionContext(companyId: string) {
    const [company, config, recentRequests] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true, sector: true, segment: true, description: true, timezone: true },
      }),
      this.prisma.agentConfig.findUnique({
        where: { companyId },
        select: {
          companyDescription: true,
          instructions: true,
          systemPrompt: true,
          toneOfVoice: true,
          welcomeMessage: true,
        },
      }),
      this.prisma.appointmentRequest.findMany({
        where: { companyId, status: { in: ['NEEDS_INFO', 'PENDING_CONFIRMATION'] } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          requestedDate: true,
          requestedTime: true,
          requestedService: true,
          status: true,
        },
      }),
    ]);

    return [
      `Empresa: ${company?.name || 'empresa'}.`,
      `Segmento: ${company?.segment || company?.sector || 'nao informado'}.`,
      `Descricao: ${config?.companyDescription || company?.description || 'nao informada'}.`,
      `Regras do atendente: ${config?.instructions || 'nao cadastradas'}.`,
      `Sistema de disponibilidade real: nao configurado.`,
      recentRequests.length
        ? `Solicitacoes recentes em aberto: ${recentRequests
            .map((item) =>
              [
                item.requestedService || 'servico nao informado',
                item.requestedDate?.toISOString().slice(0, 10) || 'data pendente',
                item.requestedTime || 'horario pendente',
                item.status,
              ].join(' | '),
            )
            .join('; ')}.`
        : 'Sem solicitacoes recentes em aberto.',
    ].join('\n');
  }
}
