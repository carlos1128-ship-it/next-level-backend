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
    let phoneNumberId = dto.phoneNumberId;
    let webhookVerifyToken = dto.webhookVerifyToken;

    if (!webhookVerifyToken) {
      const crypto = require('crypto');
      webhookVerifyToken = crypto.randomUUID();
    }

    if (!phoneNumberId && dto.phoneNumber) {
      try {
        const response = await axios.get(`${this.META_API_URL}/me/phone_numbers`, {
          headers: { Authorization: `Bearer ${dto.accessToken}` },
        });
        const numbers = response.data?.data || [];
        if (numbers.length > 0) {
          // Cleanup provided phone
          const cleanProvided = dto.phoneNumber.replace(/\D/g, '');
          const matched = numbers.find((n: any) => n.display_phone_number?.replace(/\D/g, '') === cleanProvided);
          
          if (matched) {
            phoneNumberId = matched.id;
          } else {
            phoneNumberId = numbers[0].id;
          }
        }
      } catch (error: any) {
        this.logger.warn(`Failed to auto-fetch phone_numbers: ${error.message}`);
        // We might fail, but let's let it proceed to let user know it failed later or fail here
        // If no ID is found, we'll just not update it or save with empty
      }
    }

    if (!phoneNumberId) {
      throw new BadRequestException('Não foi possível encontrar o Phone Number ID com o token fornecido.');
    }

    return this.prisma.company.update({
      where: { id: companyId },
      data: {
        metaAccessToken: dto.accessToken,
        metaPhoneNumberId: phoneNumberId,
        webhookVerifyToken: webhookVerifyToken,
        phoneNumber: dto.phoneNumber,
        instagramAccountId: dto.instagramAccountId,
      },
    });
  }

  async deleteConfig(companyId: string) {
    return this.prisma.company.update({
      where: { id: companyId },
      data: {
        metaAccessToken: null,
        metaPhoneNumberId: null,
        webhookVerifyToken: null,
      },
    });
  }

  async getHealthStatus(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { metaPhoneNumberId: true, metaAccessToken: true },
    });

    if (company?.metaPhoneNumberId && company?.metaAccessToken) {
      return { status: 'CONNECTED' };
    }
    return { status: 'DISCONNECTED' };
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
}
