import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import axios, { AxiosError, Method } from 'axios';
import { PrismaService } from '../../prisma/prisma.service';

interface GraphRequestOptions<TData = unknown> {
  companyId?: string | null;
  method: Method;
  path: string;
  accessToken: string;
  data?: TData;
  params?: Record<string, unknown>;
}

@Injectable()
export class MetaGraphService {
  private readonly graphBaseUrl: string;
  private readonly graphVersion: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.graphBaseUrl =
      this.configService.get<string>('META_GRAPH_BASE_URL')?.trim() ||
      'https://graph.facebook.com';
    const version = this.configService.get<string>('META_GRAPH_VERSION') || '20.0';
    this.graphVersion = version.replace(/^v/i, '') || '20.0';
  }

  async discoverWhatsappBusiness(accessToken: string) {
    const response = await this.requestWithRetry<{
      data?: Array<Record<string, unknown>>;
    }>({
      method: 'GET',
      path: 'me/accounts',
      accessToken,
      params: {
        fields:
          'id,name,whatsapp_business_account{id,name,phone_numbers{id,display_phone_number,verified_name}}',
      },
    });

    const accounts = Array.isArray(response?.data) ? response.data : [];
    const account = accounts.find((item) => item?.whatsapp_business_account) || accounts[0];
    const waba = account?.whatsapp_business_account as Record<string, unknown> | undefined;
    const phoneNumbersRaw =
      (waba?.phone_numbers as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined);
    const phoneNumbers = Array.isArray(phoneNumbersRaw)
      ? phoneNumbersRaw
      : Array.isArray(phoneNumbersRaw?.data)
        ? phoneNumbersRaw.data
        : [];
    const firstPhone = phoneNumbers[0];

    const phoneNumberId =
      typeof firstPhone?.id === 'string'
        ? firstPhone.id
        : typeof account?.id === 'string'
          ? account.id
          : null;
    const wabaId = typeof waba?.id === 'string' ? waba.id : null;

    if (!phoneNumberId || !wabaId) {
      throw new BadRequestException(
        'Nao foi possivel descobrir automaticamente o Phone Number ID e o WABA ID na Meta.',
      );
    }

    return {
      phoneNumberId,
      wabaId,
    };
  }

  async requestWithRetry<TResponse = unknown>({
    companyId,
    method,
    path,
    accessToken,
    data,
    params,
  }: GraphRequestOptions): Promise<TResponse> {
    const normalizedPath = path.replace(/^\/+/, '');
    const url = `${this.graphBaseUrl}/v${this.graphVersion}/${normalizedPath}`;
    const startedAt = Date.now();
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.request<TResponse>({
          url,
          method,
          data,
          params,
          timeout: 10000,
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        return response.data;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !this.shouldRetry(error)) {
          await this.logExternalFailure({
            companyId,
            method,
            path: url,
            responseTime: Date.now() - startedAt,
            statusCode: this.extractStatusCode(error),
            payload: { data, params } as Prisma.InputJsonValue,
            errorMessage: this.extractMessage(error),
          });

          throw new HttpException(
            {
              message:
                'A conexao com os servidores do WhatsApp esta instavel. Ja estamos tentando reconectar automaticamente.',
            },
            HttpStatus.FAILED_DEPENDENCY,
          );
        }

        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  }

  private shouldRetry(error: unknown) {
    if (!axios.isAxiosError(error)) return false;
    if (!error.response) return true;
    return error.response.status === 429 || error.response.status >= 500;
  }

  private extractStatusCode(error: unknown) {
    if (axios.isAxiosError(error)) {
      return error.response?.status || HttpStatus.FAILED_DEPENDENCY;
    }
    return HttpStatus.FAILED_DEPENDENCY;
  }

  private extractMessage(error: unknown) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: { message?: string } }>;
      return (
        axiosError.response?.data?.error?.message ||
        axiosError.message ||
        'Meta request failed'
      );
    }

    return error instanceof Error ? error.message : 'Meta request failed';
  }

  private async logExternalFailure(input: {
    companyId?: string | null;
    method: string;
    path: string;
    statusCode: number;
    responseTime: number;
    payload?: Prisma.InputJsonValue;
    errorMessage: string;
  }) {
    await this.prisma.apiLog
      .create({
        data: {
          method: input.method.toUpperCase(),
          path: input.path,
          statusCode: input.statusCode,
          responseTime: input.responseTime,
          status: 'FAILED',
          provider: 'META',
          errorMessage: input.errorMessage,
          companyId: input.companyId || undefined,
          payload: input.payload,
        },
      })
      .catch(() => undefined);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
