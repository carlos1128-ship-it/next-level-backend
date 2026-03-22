import { IntegrationProvider } from '@prisma/client';
import { z } from 'zod';
import { sanitizeText } from '../../../common/utils/sanitize-text.util';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform(sanitizeText)
  .optional()
  .or(z.literal('').transform(() => undefined));

export class ConnectIntegrationDto {
  static schema = z
    .object({
      provider: z.nativeEnum(IntegrationProvider),
      accessToken: z.string().trim().min(10, 'accessToken obrigatorio'),
      externalId: optionalTrimmedText,
      status: optionalTrimmedText,
      companyId: optionalTrimmedText,
    })
    .superRefine((value, ctx) => {
      if (value.provider !== IntegrationProvider.WHATSAPP && !value.externalId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['externalId'],
          message: 'externalId obrigatorio para este provedor',
        });
      }
    });

  provider!: IntegrationProvider;
  accessToken!: string;
  externalId?: string;
  status?: string;
  companyId?: string | null;
}
