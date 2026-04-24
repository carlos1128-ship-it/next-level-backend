import { Injectable } from '@nestjs/common';
import { WhatsappProviderEvolutionService } from './whatsapp-provider-evolution.service';

@Injectable()
export class EvolutionApiService {
  constructor(
    private readonly evolutionProvider: WhatsappProviderEvolutionService,
  ) {}

  createInstance(companyId: string, instanceName?: string) {
    return this.evolutionProvider.createInstance(companyId, instanceName);
  }

  connectInstance(instanceName: string) {
    return this.evolutionProvider.connectInstance(instanceName);
  }

  getConnectionState(instanceName: string) {
    return this.evolutionProvider.getConnectionState(instanceName);
  }

  setWebhook(instanceName: string, webhookUrl: string) {
    return this.evolutionProvider.setWebhook(instanceName, webhookUrl);
  }

  sendText(instanceName: string, number: string, text: string) {
    return this.evolutionProvider.sendText(instanceName, number, text);
  }

  logoutInstance(instanceName: string) {
    return this.evolutionProvider.logoutInstance(instanceName);
  }

  deleteInstance(instanceName: string) {
    return this.evolutionProvider.deleteInstance(instanceName);
  }
}
