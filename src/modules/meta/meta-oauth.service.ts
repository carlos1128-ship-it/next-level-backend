import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class MetaOAuthService {
  constructor(private prisma: PrismaService) {}

  // Step 1: Generate the OAuth URL to redirect the client to Facebook
  getOAuthUrl(companyId: string): string {
    const clientId = process.env.META_APP_ID;
    const backendUrl = process.env.BACKEND_URL;

    console.log('[MetaOAuth] Generating URL for company:', companyId);
    console.log('[MetaOAuth] META_APP_ID:', clientId ? 'DEFINED' : 'UNDEFINED');
    console.log('[MetaOAuth] BACKEND_URL:', backendUrl);

    if (!clientId) {
      throw new Error('META_APP_ID is not defined in environment variables');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${backendUrl}/api/meta/oauth/callback`,
      scope: 'whatsapp_business_management,whatsapp_business_messaging,business_management',
      response_type: 'code',
      state: companyId, // used to identify which company is connecting
    });

    const url = `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
    console.log('[MetaOAuth] Redirection URL:', url);
    return url;
  }

  // Step 2: Exchange the code for a short-lived token
  async exchangeCodeForToken(code: string): Promise<string> {
    const response = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: `${process.env.BACKEND_URL}/api/meta/oauth/callback`,
        code,
      },
    });
    return response.data.access_token;
  }

  // Step 3: Exchange short-lived token for a long-lived token (60 days)
  async getLongLivedToken(shortToken: string): Promise<string> {
    const response = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    return response.data.access_token;
  }

  // Step 4: Fetch WhatsApp Phone Number ID automatically
  async getPhoneNumberId(accessToken: string): Promise<{ phoneNumberId: string; wabaId: string }> {
    // Get WhatsApp Business Accounts linked to this token
    const wabaResponse = await axios.get(
      'https://graph.facebook.com/v19.0/me/businesses',
      { params: { access_token: accessToken } }
    );
    // Note: This logic assumes the first business has the WABA. 
    // In production, you might need to iterate or handle multiple businesses.
    const businessId = wabaResponse.data.data[0]?.id;

    if (!businessId) {
       throw new Error('No business account found for this token.');
    }

    // Get WhatsApp accounts under this business
    const waResponse = await axios.get(
      `https://graph.facebook.com/v19.0/${businessId}/owned_whatsapp_business_accounts`,
      { params: { access_token: accessToken } }
    );
    const wabaId = waResponse.data.data[0]?.id;

    if (!wabaId) {
        throw new Error('No WhatsApp Business Account found.');
    }

    // Get phone numbers under this WABA
    const phoneResponse = await axios.get(
      `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers`,
      { params: { access_token: accessToken } }
    );
    const phoneNumberId = phoneResponse.data.data[0]?.id;

    if (!phoneNumberId) {
        throw new Error('No phone number ID found.');
    }

    return { phoneNumberId, wabaId };
  }

  // Step 5: Save everything to database
  async saveOAuthConnection(companyId: string, code: string): Promise<void> {
    const shortToken = await this.exchangeCodeForToken(code);
    const longToken = await this.getLongLivedToken(shortToken);
    const { phoneNumberId, wabaId } = await this.getPhoneNumberId(longToken);

    const webhookVerifyToken = crypto.randomUUID();

    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        metaAccessToken: longToken,
        metaPhoneNumberId: phoneNumberId,
        webhookVerifyToken: webhookVerifyToken,
        whatsappBusinessId: wabaId,
      },
    });
  }
}
