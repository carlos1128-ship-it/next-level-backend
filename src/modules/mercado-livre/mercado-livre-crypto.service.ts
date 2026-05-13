import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class MercadoLivreCryptoService {
  constructor(private readonly configService: ConfigService) {}

  encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(value: string): string {
    const [version, ivRaw, tagRaw, encryptedRaw] = value.split('.');
    if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
      throw new InternalServerErrorException('Token Mercado Livre invalido');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.getKey(),
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  sign(value: string): string {
    return crypto.createHmac('sha256', this.getSigningSecret()).update(value).digest('base64url');
  }

  safeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  verifyWebhookSignature(rawBody: Buffer | undefined, body: unknown, signature: string | undefined): boolean {
    const secret = this.configService.get<string>('WEBHOOK_SECRET')?.trim();
    const required = this.configService.get<string>('MERCADOLIVRE_WEBHOOK_SECRET_REQUIRED') === 'true';
    if (!secret) return true;
    if (!signature) return !required;

    const payload = rawBody && rawBody.length > 0
      ? rawBody
      : Buffer.from(JSON.stringify(body ?? {}));
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const normalized = signature.replace(/^sha256=/i, '').trim();
    return this.safeCompare(expected, normalized);
  }

  private getKey(): Buffer {
    const raw =
      this.configService.get<string>('ML_TOKEN_ENCRYPTION_KEY')?.trim() ||
      this.configService.get<string>('MERCADOLIVRE_TOKEN_ENCRYPTION_KEY')?.trim() ||
      this.configService.get<string>('JWT_SECRET')?.trim() ||
      this.configService.get<string>('ML_CLIENT_SECRET')?.trim() ||
      this.configService.get<string>('MERCADOLIVRE_OAUTH_CLIENT_SECRET')?.trim();

    if (!raw) {
      throw new InternalServerErrorException('Configure ML_TOKEN_ENCRYPTION_KEY ou JWT_SECRET');
    }

    return crypto.createHash('sha256').update(raw).digest();
  }

  private getSigningSecret(): string {
    const secret =
      this.configService.get<string>('ML_STATE_SECRET')?.trim() ||
      this.configService.get<string>('JWT_SECRET')?.trim() ||
      this.configService.get<string>('WEBHOOK_SECRET')?.trim();

    if (!secret) {
      throw new InternalServerErrorException('Configure ML_STATE_SECRET ou JWT_SECRET');
    }

    return secret;
  }
}
