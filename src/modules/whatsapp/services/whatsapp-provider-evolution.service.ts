import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

const DEFAULT_WEBHOOK_EVENTS = [
  'QRCODE_UPDATED',
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'SEND_MESSAGE',
];

type EvolutionRequestMethod = 'GET' | 'POST' | 'DELETE';

type RemoteStateSnapshot = {
  state: string;
  phoneNumber: string | null;
};

type RemoteInstanceLookup = RemoteStateSnapshot & {
  exists: boolean;
};

type ConnectInstanceResult = {
  status: string;
  qrCode: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
};

type CreateInstanceOptions = {
  webhookUrl?: string | null;
  events?: string[];
  webhookHeaders?: Record<string, string>;
};

class EvolutionProviderException extends BadRequestException {
  constructor(
    message: string,
    readonly providerStatusCode: number | null,
    readonly providerResponse: unknown,
  ) {
    super(message);
  }
}

@Injectable()
export class WhatsappProviderEvolutionService {
  private readonly logger = new Logger(WhatsappProviderEvolutionService.name);
  private readonly api: AxiosInstance;
  private readonly baseUrl: string | null;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.readString(
      this.configService.get<string>('EVOLUTION_BASE_URL') ||
        this.configService.get<string>('EVOLUTION_API_URL') ||
        this.configService.get<string>('WHATSAPP_PROVIDER_BASE_URL'),
    );
    this.apiKey = this.readString(
      this.configService.get<string>('EVOLUTION_API_KEY') ||
        this.configService.get<string>('WHATSAPP_PROVIDER_API_KEY'),
    );
    this.timeoutMs = this.readPositiveInt(
      this.configService.get<string>('EVOLUTION_API_TIMEOUT_MS') ||
        this.configService.get<string>('WHATSAPP_PROVIDER_TIMEOUT_MS'),
      10000,
    );

    this.api = axios.create({
      baseURL: this.baseUrl || undefined,
      timeout: this.timeoutMs,
      headers: {
        ...(this.apiKey
          ? {
              apikey: this.apiKey,
              Authorization: `Bearer ${this.apiKey}`,
            }
          : {}),
        'Content-Type': 'application/json',
      },
    });
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.apiKey);
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  async createInstance(
    companyId: string,
    instanceName = this.buildInstanceName(companyId),
    options: CreateInstanceOptions = {},
  ) {
    this.ensureConfigured();

    const remoteBefore = await this.findRemoteInstance(instanceName).catch(() => null);
    if (remoteBefore?.exists) {
      return { instanceName, reused: true, state: remoteBefore.state };
    }

    const webhook = options.webhookUrl
      ? {
          enabled: true,
          url: options.webhookUrl,
          byEvents: false,
          base64: true,
          events: options.events || DEFAULT_WEBHOOK_EVENTS,
          headers: options.webhookHeaders || {},
        }
      : undefined;

    try {
      return await this.request({
        method: 'POST',
        path: 'instance/create',
        data: {
          instanceName,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          rejectCall: false,
          groupsIgnore: true,
          alwaysOnline: false,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
          ...(webhook ? { webhook } : {}),
          metadata: {
            companyId,
            source: 'next-level',
          },
        },
      });
    } catch (error) {
      if (!this.canReuseAfterCreateFailure(error)) {
        throw error;
      }

      const remoteAfter = await this.findRemoteInstance(instanceName).catch(() => null);
      if (!remoteAfter?.exists) {
        throw error;
      }

      this.logger.warn(
        `Evolution create-instance falhou, mas a instancia ${instanceName} existe; seguindo com reuso seguro.`,
      );
      return { instanceName, reused: true, state: remoteAfter.state };
    }
  }

  async connectInstance(
    input:
      | string
      | {
          instanceName: string;
          webhookUrl?: string | null;
          webhookHeaders?: Record<string, string>;
        },
  ): Promise<ConnectInstanceResult> {
    this.ensureConfigured();

    const instanceName = typeof input === 'string' ? input : input.instanceName;
    if (typeof input !== 'string') {
      await this.createInstance('', instanceName, {
        webhookUrl: input.webhookUrl,
        webhookHeaders: input.webhookHeaders,
      });
      if (input.webhookUrl) {
        await this.setWebhook(
          instanceName,
          input.webhookUrl,
          DEFAULT_WEBHOOK_EVENTS,
          input.webhookHeaders,
        );
      }
    }

    const response = await this.request<Record<string, unknown>>({
      method: 'GET',
      path: `instance/connect/${encodeURIComponent(instanceName)}`,
    });

    const qrCode = this.extractQrCode(response);
    const pairingCode = this.readString(response?.pairingCode);
    const state = await this.getConnectionState(instanceName).catch(() => ({
      state: qrCode ? 'connecting' : 'close',
      phoneNumber: null,
    }));

    return {
      status: qrCode ? 'waiting_qr' : this.mapStateToStatus(state.state, qrCode),
      qrCode,
      pairingCode,
      phoneNumber: state.phoneNumber,
    };
  }

  async getConnectionState(instanceName: string): Promise<RemoteStateSnapshot> {
    this.ensureConfigured();

    try {
      const response = await this.request<{
        instance?: { state?: string; ownerJid?: string; number?: string };
      }>({
        method: 'GET',
        path: `instance/connectionState/${encodeURIComponent(instanceName)}`,
      });

      const instance = response?.instance;
      return {
        state: this.normalizeRemoteState(this.readString(instance?.state)),
        phoneNumber: this.normalizePhone(
          this.readString(instance?.number) || this.readString(instance?.ownerJid),
        ),
      };
    } catch (error) {
      if (!this.shouldFallbackToFetchInstances(error)) {
        throw error;
      }
    }

    const response = await this.request<unknown>({
      method: 'GET',
      path: 'instance/fetchInstances',
      params: { instanceName },
    });

    const instance = this.extractFetchedInstance(response, instanceName);
    if (!instance) {
      return { state: 'close', phoneNumber: null };
    }

    return {
      state: this.normalizeRemoteState(instance.state),
      phoneNumber: this.normalizePhone(instance.number),
    };
  }

  async getInstanceState(instanceName: string) {
    return this.getConnectionState(instanceName);
  }

  async findRemoteInstance(instanceName: string): Promise<RemoteInstanceLookup> {
    this.ensureConfigured();

    try {
      const response = await this.request<{
        instance?: { state?: string; ownerJid?: string; number?: string };
      }>({
        method: 'GET',
        path: `instance/connectionState/${encodeURIComponent(instanceName)}`,
      });

      const instance = response?.instance;
      if (instance) {
        return {
          exists: true,
          state: this.normalizeRemoteState(this.readString(instance.state)),
          phoneNumber: this.normalizePhone(
            this.readString(instance.number) || this.readString(instance.ownerJid),
          ),
        };
      }
    } catch (error) {
      if (
        !this.shouldFallbackToFetchInstances(error) &&
        this.extractStatusCode(error) !== 403
      ) {
        throw error;
      }
    }

    const response = await this.request<unknown>({
      method: 'GET',
      path: 'instance/fetchInstances',
      params: { instanceName },
    });

    const instance = this.extractFetchedInstance(response, instanceName);
    if (!instance) {
      return { exists: false, state: 'close', phoneNumber: null };
    }

    return {
      exists: true,
      state: this.normalizeRemoteState(instance.state),
      phoneNumber: this.normalizePhone(instance.number),
    };
  }

  async setWebhook(
    instanceName: string,
    webhookUrl: string,
    events: string[] = DEFAULT_WEBHOOK_EVENTS,
    headers?: Record<string, string>,
  ) {
    this.ensureConfigured();

    const path = `webhook/set/${encodeURIComponent(instanceName)}`;
    const flatPayload = {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: true,
      events,
      headers: headers || {},
    };

    try {
      return await this.request({
        method: 'POST',
        path,
        data: flatPayload,
      });
    } catch (error) {
      if (this.isAuthenticationMessage(error)) {
        throw error;
      }
    }

    return this.request({
      method: 'POST',
      path,
      data: {
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: true,
          events,
          headers: headers || {},
        },
      },
    });
  }

  async getWebhook(instanceName: string) {
    this.ensureConfigured();

    return this.request<unknown>({
      method: 'GET',
      path: `webhook/find/${encodeURIComponent(instanceName)}`,
    });
  }

  async verifyWebhook(instanceName: string, expectedUrl: string) {
    try {
      const response = await this.getWebhook(instanceName);
      const webhook = this.asRecord(this.asRecord(response)?.webhook) || this.asRecord(response);
      const nestedWebhook = this.asRecord(webhook?.webhook);
      const remoteUrl =
        this.readString(webhook?.url) ||
        this.readString(nestedWebhook?.url);
      const enabled =
        webhook?.enabled === true ||
        nestedWebhook?.enabled === true ||
        this.readString(webhook?.enabled)?.toLowerCase() === 'true';

      return Boolean(enabled && remoteUrl === expectedUrl);
    } catch (error) {
      this.logger.warn(
        `Nao foi possivel verificar webhook Evolution para ${instanceName}: ${this.extractErrorMessage(error)}`,
      );
      return false;
    }
  }

  async logoutInstance(instanceName: string) {
    this.ensureConfigured();

    return this.request({
      method: 'DELETE',
      path: `instance/logout/${encodeURIComponent(instanceName)}`,
    }).catch(() => undefined);
  }

  async deleteInstance(instanceName: string) {
    this.ensureConfigured();

    return this.request({
      method: 'DELETE',
      path: `instance/delete/${encodeURIComponent(instanceName)}`,
    }).catch(() => undefined);
  }

  async disconnectInstance(instanceName: string) {
    await this.logoutInstance(instanceName);
    await this.deleteInstance(instanceName);
  }

  async sendTextMessage(instanceName: string, to: string, text: string) {
    this.ensureConfigured();

    return this.request({
      method: 'POST',
      path: `message/sendText/${encodeURIComponent(instanceName)}`,
      data: {
        number: this.normalizePhone(to),
        text: text.trim(),
        delay: 0,
        linkPreview: false,
      },
    });
  }

  async sendText(instanceName: string, number: string, text: string) {
    return this.sendTextMessage(instanceName, number, text);
  }

  private async request<TResponse = unknown>(input: {
    method: EvolutionRequestMethod;
    path: string;
    data?: Record<string, unknown>;
    params?: Record<string, string>;
  }): Promise<TResponse> {
    this.ensureConfigured();

    const normalizedPath = input.path.replace(/^\/+/, '');

    try {
      const response = await this.api.request<TResponse>({
        method: input.method,
        url: normalizedPath,
        data: input.data,
        params: input.params,
      });
      return response.data;
    } catch (error) {
      const message = this.extractErrorMessage(error);
      const statusCode = this.extractStatusCode(error);
      const responseData = axios.isAxiosError(error) ? error.response?.data : null;
      this.logger.error(
        JSON.stringify({
          event: 'evolution.provider.failure',
          method: input.method,
          path: normalizedPath,
          statusCode,
          message,
          response: this.sanitizeForLogs(responseData),
        }),
      );
      throw new EvolutionProviderException(message, statusCode, responseData);
    }
  }

  private extractQrCode(payload: Record<string, unknown> | null | undefined) {
    const data = this.asRecord(payload?.data);
    const qrcode = this.asRecord(payload?.qrcode) || this.asRecord(data?.qrcode);
    return this.normalizeQrCode(
      this.readString(payload?.code) ||
        this.readString(payload?.base64) ||
        this.readString(qrcode?.base64) ||
        this.readString(data?.code) ||
        this.readString(data?.base64),
    );
  }

  private extractFetchedInstance(payload: unknown, instanceName: string) {
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { response?: unknown[] })?.response)
        ? (payload as { response?: unknown[] }).response || []
        : [];

    for (const candidate of items) {
      const raw = this.asRecord(this.asRecord(candidate)?.instance || candidate);
      const currentInstanceName = this.readString(raw?.instanceName);
      if (currentInstanceName !== instanceName) {
        continue;
      }

      return {
        state: this.readString(raw?.state) || this.readString(raw?.status) || 'close',
        number: this.readString(raw?.number) || this.readString(raw?.ownerJid),
      };
    }

    return null;
  }

  private mapStateToStatus(state: string, qrCode: string | null) {
    if (state === 'open') {
      return 'connected';
    }

    if (qrCode || state === 'connecting') {
      return 'waiting_qr';
    }

    if (state === 'close') {
      return 'disconnected';
    }

    return 'error';
  }

  private normalizeRemoteState(value: string | null) {
    const normalized = value?.trim().toLowerCase();

    if (!normalized) {
      return 'close';
    }

    if (normalized === 'connected') {
      return 'open';
    }

    if (normalized === 'disconnected') {
      return 'close';
    }

    if (normalized === 'created') {
      return 'connecting';
    }

    return normalized;
  }

  private normalizeQrCode(value: string | null) {
    if (!value) {
      return null;
    }

    if (value.startsWith('data:')) {
      return value;
    }

    if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length > 100) {
      return `data:image/png;base64,${value}`;
    }

    return value;
  }

  private normalizePhone(value: string | null) {
    if (!value) {
      return '';
    }

    return value
      .replace('@s.whatsapp.net', '')
      .replace('@c.us', '')
      .replace(/\D/g, '');
  }

  private buildInstanceName(companyId: string) {
    return `nextlevel-${companyId}`;
  }

  private shouldFallbackToFetchInstances(error: unknown) {
    const statusCode = this.extractStatusCode(error);
    const message = this.extractErrorMessage(error).toLowerCase();
    return (
      !statusCode ||
      [404, 405, 500, 501, 502, 503, 504].includes(statusCode) ||
      message.includes('not found') ||
      message.includes('nao encontrado') ||
      message.includes('nao existe') ||
      message.includes('fetchinstances')
    );
  }

  private isConflictMessage(error: unknown) {
    const message = this.extractErrorMessage(error).toLowerCase();
    return (
      message.includes('already exist') ||
      message.includes('already exists') ||
      message.includes('instance exists') ||
      message.includes('ja existe')
    );
  }

  private isAuthenticationMessage(error: unknown) {
    const statusCode = this.extractStatusCode(error);
    if (statusCode === 401 || statusCode === 403) {
      return true;
    }

    const message = this.extractErrorMessage(error).toLowerCase();
    return message.includes('unauthorized') || message.includes('forbidden');
  }

  private canReuseAfterCreateFailure(error: unknown) {
    const statusCode = this.extractStatusCode(error);
    if (statusCode && [400, 403, 409, 500].includes(statusCode)) {
      return true;
    }

    return this.isConflictMessage(error);
  }

  private extractStatusCode(error: unknown) {
    if (error instanceof EvolutionProviderException) {
      return error.providerStatusCode;
    }

    return axios.isAxiosError(error) && error.response?.status
      ? error.response.status
      : null;
  }

  private extractErrorMessage(error: unknown) {
    if (error instanceof BadRequestException) {
      if (error instanceof EvolutionProviderException) {
        return error.message;
      }

      const response = error.getResponse();
      if (typeof response === 'string') return response;
      const record = this.asRecord(response);
      return this.readString(record?.message) || error.message;
    }

    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : 'Falha ao comunicar com a Evolution API';
    }

    const responseData = error.response?.data;
    if (typeof responseData === 'string' && responseData.trim()) {
      return responseData;
    }

    const record = this.asRecord(responseData);
    return (
      this.readString(record?.message) ||
      this.readString(this.asRecord(record?.response)?.message) ||
      this.readString(record?.error) ||
      error.message ||
      'Falha ao comunicar com a Evolution API'
    );
  }

  private sanitizeForLogs(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeForLogs(item));
    }

    if (!value || typeof value !== 'object') {
      if (typeof value === 'string') {
        return this.redactSensitiveUrl(value);
      }
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
        const normalizedKey = key.toLowerCase();
        if (
          normalizedKey.includes('apikey') ||
          normalizedKey.includes('authorization') ||
          normalizedKey.includes('token') ||
          normalizedKey.includes('password')
        ) {
          return [key, '<redacted>'];
        }

        if (normalizedKey === 'url' && typeof entryValue === 'string') {
          return [key, this.redactSensitiveUrl(entryValue)];
        }

        return [key, this.sanitizeForLogs(entryValue)];
      }),
    );
  }

  private redactSensitiveUrl(value: string) {
    try {
      const url = new URL(value);
      for (const key of ['token', 'apikey', 'authorization']) {
        if (url.searchParams.has(key)) {
          url.searchParams.set(key, '<redacted>');
        }
      }
      return url.toString();
    } catch {
      return value;
    }
  }

  private ensureConfigured() {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'EVOLUTION_BASE_URL e EVOLUTION_API_KEY precisam estar configuradas',
      );
    }
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readPositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private asRecord(value: unknown) {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  }
}
