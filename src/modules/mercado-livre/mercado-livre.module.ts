import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { MercadoLivreApiService } from './mercado-livre-api.service';
import { MercadoLivreAuthController } from './mercado-livre-auth.controller';
import { MercadoLivreAuthService } from './mercado-livre-auth.service';
import { MercadoLivreController } from './mercado-livre.controller';
import { MercadoLivreCronService } from './mercado-livre-cron.service';
import { MercadoLivreCryptoService } from './mercado-livre-crypto.service';
import { MercadoLivreSyncService } from './mercado-livre-sync.service';
import { MercadoLivreWebhookController } from './mercado-livre-webhook.controller';
import { MercadoLivreWebhookService } from './mercado-livre-webhook.service';

@Module({
  imports: [WebhooksModule],
  controllers: [
    MercadoLivreAuthController,
    MercadoLivreController,
    MercadoLivreWebhookController,
  ],
  providers: [
    MercadoLivreApiService,
    MercadoLivreAuthService,
    MercadoLivreCryptoService,
    MercadoLivreSyncService,
    MercadoLivreCronService,
    MercadoLivreWebhookService,
  ],
  exports: [
    MercadoLivreAuthService,
    MercadoLivreSyncService,
    MercadoLivreWebhookService,
  ],
})
export class MercadoLivreModule {}
