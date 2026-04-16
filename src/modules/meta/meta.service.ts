import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SaveMetaConfigDto } from './dto/save-meta-config.dto';
import axios from 'axios';

@Injectable()
export class MetaIntegrationService {
  private readonly logger = new Logger(MetaIntegrationService.name);
  private readonly META_API_URL = 'https://graph.facebook.com/v19.0';

  constructor(private readonly prisma: PrismaService) {}

  private async getCompanyConfig(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        metaAccessToken: true,
        metaPhoneNumberId: true,
      },
    });

    if (!company?.metaAccessToken || !company?.metaPhoneNumberId) {
      throw new BadRequestException('Meta API configuration missing for this company.');
    }

    return company;
  }

  async saveConfig(companyId: string, dto: SaveMetaConfigDto) {
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        metaAccessToken: dto.accessToken,
        metaPhoneNumberId: dto.phoneNumberId,
        webhookVerifyToken: dto.webhookVerifyToken,
        ...(dto.instagramAccountId && { instagramAccountId: dto.instagramAccountId }),
      },
    });
    return { success: true };
  }

  async sendTextMessage(companyId: string, phone: string, text: string) {
    const { metaAccessToken, metaPhoneNumberId } = await this.getCompanyConfig(companyId);

    const url = `${this.META_API_URL}/${metaPhoneNumberId}/messages`;
    
    try {
      const response = await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: phone,
          type: 'text',
          text: {
            preview_url: false,
            body: text,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${metaAccessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to send WhatsApp message to ${phone}: ${error?.response?.data?.error?.message || error.message}`);
      throw error;
    }
  }

  async sendTemplateMessage(companyId: string, phone: string, templateName: string, languageCode: string = 'pt_BR', components: any[] = []) {
    const { metaAccessToken, metaPhoneNumberId } = await this.getCompanyConfig(companyId);

    const url = `${this.META_API_URL}/${metaPhoneNumberId}/messages`;

    try {
      const response = await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: phone,
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: languageCode,
            },
            components: components,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${metaAccessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to send WhatsApp template to ${phone}: ${error?.response?.data?.error?.message || error.message}`);
      throw error;
    }
  }

  async sendBulkMessages({ companyId, numbers, message }: { companyId: string, numbers: string[], message: string }) {
    const results = [];
    for (const number of numbers) {
      try {
        await this.sendTextMessage(companyId, number, message);
        results.push({ number, status: 'SUCCESS' });
      } catch (error: any) {
        results.push({ number, status: 'FAILED', error: error.message });
      }
    }
    return results;
  }

  async getHealthStatus(companyId: string) {
    try {
      await this.getCompanyConfig(companyId);
      return { status: 'CONNECTED', message: 'Meta API configured successfully.' };
    } catch (error) {
      return { status: 'DISCONNECTED', message: 'Not configured.' };
    }
  }
}
