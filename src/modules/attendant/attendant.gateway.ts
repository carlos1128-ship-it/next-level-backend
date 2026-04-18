import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

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

  handleConnection(client: Socket) {
    const companyId = this.resolveCompanyId(client);
    if (!companyId) {
      client.disconnect();
      return;
    }

    void client.join(this.room(companyId));
    this.logger.log(`Cliente conectado ao live feed da empresa ${companyId}`);
  }

  handleDisconnect(client: Socket) {
    const companyId = this.resolveCompanyId(client);
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

  emitWhatsappQr(companyId: string, payload: { qrCode: string; attempts: number; sessionName: string }) {
    this.server.to(this.room(companyId)).emit('whatsapp.qr', {
      companyId,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  private resolveCompanyId(client: Socket) {
    const raw = client.handshake.query.companyId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  private room(companyId: string) {
    return `company:${companyId}`;
  }
}
