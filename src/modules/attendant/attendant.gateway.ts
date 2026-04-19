import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';

type JwtSocketPayload = {
  sub: string;
  admin?: boolean;
  companyId?: string;
};

@WebSocketGateway({
  namespace: '/attendant',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class AttendantGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AttendantGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: Socket) {
    const companyId = this.resolveCompanyId(client);
    const payload = this.resolveTokenPayload(client);

    if (!companyId || !payload?.sub) {
      client.disconnect();
      return;
    }

    const allowed = await this.canAccessCompany(payload, companyId);
    if (!allowed) {
      client.disconnect();
      return;
    }

    client.data.companyId = companyId;
    await client.join(this.room(companyId));
    this.logger.log(`Cliente autenticado no live feed da empresa ${companyId}`);
  }

  handleDisconnect(client: Socket) {
    const companyId = client.data.companyId as string | undefined;
    if (!companyId) {
      return;
    }

    this.logger.log(`Cliente desconectado do live feed da empresa ${companyId}`);
  }

  emitConversationEvent(companyId: string, payload: Record<string, unknown>) {
    this.server.to(this.room(companyId)).emit('conversation.updated', payload);
  }

  emitWhatsappStatus(companyId: string, status: string) {
    this.server.to(this.room(companyId)).emit('whatsapp.status', {
      companyId,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  emitWhatsappQr(
    companyId: string,
    payload: { qrCode: string; attempts: number; sessionName: string },
  ) {
    this.server.to(this.room(companyId)).emit('whatsapp.qr', {
      companyId,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  private resolveTokenPayload(client: Socket): JwtSocketPayload | null {
    const authToken =
      this.asString(client.handshake.auth?.token) ||
      this.extractBearerToken(this.asString(client.handshake.headers.authorization));

    if (!authToken) {
      return null;
    }

    try {
      return this.jwtService.verify<JwtSocketPayload>(authToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      return null;
    }
  }

  private async canAccessCompany(
    payload: JwtSocketPayload,
    companyId: string,
  ): Promise<boolean> {
    if (payload.admin) {
      return true;
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        OR: [
          { userId: payload.sub },
          { users: { some: { id: payload.sub } } },
        ],
      },
      select: { id: true },
    });

    return Boolean(company?.id);
  }

  private resolveCompanyId(client: Socket) {
    return this.asString(client.handshake.query.companyId);
  }

  private extractBearerToken(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const match = value.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private room(companyId: string) {
    return `company:${companyId}`;
  }
}
