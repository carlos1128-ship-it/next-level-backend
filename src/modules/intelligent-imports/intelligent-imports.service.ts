import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportedEntity,
  ImportedMetric,
  IntelligentImport,
  Prisma,
} from '@prisma/client';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateIntelligentTextImportDto } from './dto/create-intelligent-text-import.dto';
import { ReviewIntelligentImportDto } from './dto/review-intelligent-import.dto';
import { UploadIntelligentImportFileDto } from './dto/upload-intelligent-import-file.dto';
import { IntelligentImportAiService } from './intelligent-import-ai.service';
import {
  IMPORTED_ENTITY_STATUSES,
  IMPORTED_ENTITY_TYPES,
  IMPORTED_METRIC_SOURCES,
  IMPORTED_METRIC_STATUSES,
  IMPORTED_METRIC_UNITS,
  INTELLIGENT_IMPORT_CATEGORIES,
  INTELLIGENT_IMPORT_INPUT_TYPES,
  INTELLIGENT_IMPORT_STATUSES,
  MAX_IMPORT_FILE_SIZE_BYTES,
  SUPPORTED_UPLOAD_MIME_TYPES,
} from './intelligent-imports.constants';

type PersistedImport = IntelligentImport & {
  importedMetrics?: ImportedMetric[];
  importedEntities?: ImportedEntity[];
};

type StoredFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

@Injectable()
export class IntelligentImportsService {
  private readonly privateStorageRoot = path.join(process.cwd(), 'private-imports');

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: IntelligentImportAiService,
  ) {}

  async listImports(userId: string, companyId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const imports = await this.prisma.intelligentImport.findMany({
      where: { companyId },
      include: {
        importedMetrics: {
          orderBy: { createdAt: 'asc' },
        },
        importedEntities: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return imports.map((item) => this.toPublicImport(item));
  }

  async createTextImport(
    userId: string,
    companyId: string,
    body: CreateIntelligentTextImportDto,
  ) {
    const normalizedCompanyId = await this.ensureCompanyAccess(userId, companyId);
    const text = body.text.trim();
    const created = await this.prisma.intelligentImport.create({
      data: {
        companyId: normalizedCompanyId,
        userId,
        inputType: INTELLIGENT_IMPORT_INPUT_TYPES.TEXT,
        pastedText: text,
        rawContentText: text,
        expectedCategory: body.expectedCategory || 'auto',
        status: INTELLIGENT_IMPORT_STATUSES.UPLOADED,
      },
      include: {
        importedMetrics: true,
        importedEntities: true,
      },
    });

    return this.toPublicImport(created);
  }

  async uploadFile(
    userId: string,
    companyId: string,
    body: UploadIntelligentImportFileDto,
    file?: StoredFile,
  ) {
    const normalizedCompanyId = await this.ensureCompanyAccess(userId, companyId);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Arquivo obrigatorio');
    }
    if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
      throw new BadRequestException('Arquivo acima do limite de 10 MB');
    }
    if (!SUPPORTED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Tipo de arquivo nao suportado');
    }

    const inputType = this.resolveInputType(file);
    const rawContentText =
      inputType === INTELLIGENT_IMPORT_INPUT_TYPES.CSV ||
      inputType === INTELLIGENT_IMPORT_INPUT_TYPES.TEXT ||
      inputType === INTELLIGENT_IMPORT_INPUT_TYPES.DOCUMENT
        ? file.buffer.toString('utf8').replace(/^\uFEFF/, '').trim()
        : null;
    const previewJson =
      inputType === INTELLIGENT_IMPORT_INPUT_TYPES.CSV && rawContentText
        ? this.buildCsvPreview(rawContentText)
        : Prisma.DbNull;
    const storageKey =
      inputType === INTELLIGENT_IMPORT_INPUT_TYPES.IMAGE ||
      inputType === INTELLIGENT_IMPORT_INPUT_TYPES.PDF
        ? await this.storePrivateFile(normalizedCompanyId, file)
        : null;

    const created = await this.prisma.intelligentImport.create({
      data: {
        companyId: normalizedCompanyId,
        userId,
        inputType,
        fileName: file.originalname,
        fileMimeType: file.mimetype,
        fileSize: file.size,
        storageKey,
        expectedCategory: body.expectedCategory || 'auto',
        rawContentText: rawContentText || null,
        previewJson,
        status: INTELLIGENT_IMPORT_STATUSES.UPLOADED,
      },
      include: {
        importedMetrics: true,
        importedEntities: true,
      },
    });

    return this.toPublicImport(created);
  }

  async analyzeImport(userId: string, companyId: string, importId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const current = await this.findOwnedImport(companyId, importId);
    if (
      current.status === INTELLIGENT_IMPORT_STATUSES.CONFIRMED ||
      current.status === INTELLIGENT_IMPORT_STATUSES.REJECTED
    ) {
      throw new BadRequestException('Importacao nao pode mais ser analisada');
    }

    await this.prisma.intelligentImport.update({
      where: { id: current.id },
      data: { status: INTELLIGENT_IMPORT_STATUSES.ANALYZING, errorMessage: null },
    });

    const result = await this.runAnalysis(current);
    const nextStatus = this.resolveAnalysisStatus(current.inputType, result);
    const updated = await this.prisma.intelligentImport.update({
      where: { id: current.id },
      data: {
        status: nextStatus,
        detectedCategory: this.toDetectedCategoryEnum(result.detectedCategory),
        detectedPlatform: result.detectedPlatform,
        detectedPeriodStart: result.period.startDate ? new Date(`${result.period.startDate}T00:00:00.000Z`) : null,
        detectedPeriodEnd: result.period.endDate ? new Date(`${result.period.endDate}T23:59:59.999Z`) : null,
        confidence: result.confidence,
        aiSummary: result.summary,
        extractedJson: result as unknown as Prisma.InputJsonValue,
        warningsJson:
          result.warnings.length > 0
            ? (result.warnings as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        previewJson:
          result.previewRows && result.previewRows.length
            ? (result.previewRows as unknown as Prisma.InputJsonValue)
            : current.previewJson ?? Prisma.DbNull,
        errorMessage:
          nextStatus === INTELLIGENT_IMPORT_STATUSES.FAILED
            ? result.warnings.join(' | ') || 'Falha ao analisar importacao'
            : null,
      },
      include: {
        importedMetrics: true,
        importedEntities: true,
      },
    });

    return this.toPublicImport(updated);
  }

  async getImport(userId: string, companyId: string, importId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const item = await this.prisma.intelligentImport.findFirst({
      where: { id: importId, companyId },
      include: {
        importedMetrics: {
          orderBy: { createdAt: 'asc' },
        },
        importedEntities: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!item) {
      throw new NotFoundException('Importacao nao encontrada');
    }
    return this.toPublicImport(item);
  }

  async reviewImport(
    userId: string,
    companyId: string,
    importId: string,
    body: ReviewIntelligentImportDto,
  ) {
    await this.ensureCompanyAccess(userId, companyId);
    const current = await this.findOwnedImport(companyId, importId);
    if (
      current.status === INTELLIGENT_IMPORT_STATUSES.CONFIRMED ||
      current.status === INTELLIGENT_IMPORT_STATUSES.REJECTED
    ) {
      throw new BadRequestException('Importacao nao pode mais ser editada');
    }

    const existingExtraction = this.readExtraction(current);
    const nextExtraction = {
      ...existingExtraction,
      detectedCategory: this.normalizeLowerCategory(body.detectedCategory) || existingExtraction.detectedCategory,
      detectedPlatform: this.normalizeLowerPlatform(body.detectedPlatform) || existingExtraction.detectedPlatform,
      period: {
        startDate: body.detectedPeriodStart || existingExtraction.period.startDate,
        endDate: body.detectedPeriodEnd || existingExtraction.period.endDate,
        label: existingExtraction.period.label,
      },
      confidence:
        typeof body.confidence === 'number' ? Math.max(0, Math.min(1, body.confidence)) : existingExtraction.confidence,
      summary: body.summary?.trim() || existingExtraction.summary,
      metrics: Array.isArray(body.metrics)
        ? body.metrics.map((item) => ({
            metricKey: item.metricKey,
            label: item.label,
            value: item.value,
            unit: this.normalizeLowerUnit(item.unit),
            currency: item.currency || null,
            confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
            sourceText: item.sourceText,
          }))
        : existingExtraction.metrics,
      entities: Array.isArray(body.entities)
        ? body.entities.map((item) => ({
            entityType: this.normalizeLowerEntityType(item.entityType),
            data: item.data,
            confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
          }))
        : existingExtraction.entities,
      warnings: Array.isArray(body.warnings) ? body.warnings : existingExtraction.warnings,
      needsUserReview: true,
      previewRows: existingExtraction.previewRows,
      suggestedMapping: existingExtraction.suggestedMapping,
    };

    const updated = await this.prisma.intelligentImport.update({
      where: { id: current.id },
      data: {
        expectedCategory: body.expectedCategory || current.expectedCategory,
        detectedCategory: this.toDetectedCategoryEnum(nextExtraction.detectedCategory),
        detectedPlatform: nextExtraction.detectedPlatform,
        detectedPeriodStart: nextExtraction.period.startDate ? new Date(`${nextExtraction.period.startDate}T00:00:00.000Z`) : null,
        detectedPeriodEnd: nextExtraction.period.endDate ? new Date(`${nextExtraction.period.endDate}T23:59:59.999Z`) : null,
        confidence: nextExtraction.confidence,
        aiSummary: nextExtraction.summary,
        extractedJson: nextExtraction as unknown as Prisma.InputJsonValue,
        warningsJson:
          nextExtraction.warnings.length > 0
            ? (nextExtraction.warnings as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        status: INTELLIGENT_IMPORT_STATUSES.NEEDS_REVIEW,
        errorMessage: null,
      },
      include: {
        importedMetrics: true,
        importedEntities: true,
      },
    });

    return this.toPublicImport(updated);
  }

  async confirmImport(userId: string, companyId: string, importId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const current = await this.findOwnedImport(companyId, importId);
    if (current.status !== INTELLIGENT_IMPORT_STATUSES.NEEDS_REVIEW) {
      throw new BadRequestException('Importacao precisa ser analisada e revisada antes da confirmacao');
    }

    const extraction = this.readExtraction(current);
    const metricSource = this.resolveMetricSource(current.inputType);
    await this.prisma.$transaction(async (tx) => {
      await tx.importedMetric.deleteMany({ where: { importId: current.id } });
      await tx.importedEntity.deleteMany({ where: { importId: current.id } });

      for (const metric of extraction.metrics) {
        await tx.importedMetric.create({
          data: {
            companyId: current.companyId,
            importId: current.id,
            metricKey: metric.metricKey,
            label: metric.label,
            value: metric.value as Prisma.InputJsonValue,
            unit: this.toMetricUnitEnum(metric.unit),
            currency: metric.currency || (metric.unit === 'currency' ? 'BRL' : null),
            periodStart: extraction.period.startDate ? new Date(`${extraction.period.startDate}T00:00:00.000Z`) : null,
            periodEnd: extraction.period.endDate ? new Date(`${extraction.period.endDate}T23:59:59.999Z`) : null,
            source: metricSource,
            platform: extraction.detectedPlatform,
            confidence: metric.confidence,
            status: IMPORTED_METRIC_STATUSES.CONFIRMED,
            metadataJson:
              metric.sourceText
                ? ({ sourceText: metric.sourceText } as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
          },
        });
      }

      for (const entity of extraction.entities) {
        await tx.importedEntity.create({
          data: {
            companyId: current.companyId,
            importId: current.id,
            entityType: this.toEntityTypeEnum(entity.entityType),
            normalizedJson: entity.data as Prisma.InputJsonValue,
            confidence: entity.confidence,
            status: IMPORTED_ENTITY_STATUSES.CONFIRMED,
          },
        });
      }

      await tx.intelligentImport.update({
        where: { id: current.id },
        data: {
          status: INTELLIGENT_IMPORT_STATUSES.CONFIRMED,
          confirmedAt: new Date(),
          errorMessage: null,
        },
      });
    });

    return this.getImport(userId, companyId, importId);
  }

  async rejectImport(userId: string, companyId: string, importId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const current = await this.findOwnedImport(companyId, importId);
    if (current.status === INTELLIGENT_IMPORT_STATUSES.CONFIRMED) {
      throw new BadRequestException('Importacao confirmada nao pode ser rejeitada');
    }

    const updated = await this.prisma.intelligentImport.update({
      where: { id: current.id },
      data: {
        status: INTELLIGENT_IMPORT_STATUSES.REJECTED,
      },
      include: {
        importedMetrics: true,
        importedEntities: true,
      },
    });
    return this.toPublicImport(updated);
  }

  async listImportedMetrics(userId: string, companyId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const metrics = await this.prisma.importedMetric.findMany({
      where: {
        companyId,
        status: IMPORTED_METRIC_STATUSES.CONFIRMED,
      },
      orderBy: { createdAt: 'desc' },
    });

    return metrics.map((metric) => this.toPublicImportedMetric(metric));
  }

  private async runAnalysis(current: IntelligentImport) {
    switch (current.inputType) {
      case INTELLIGENT_IMPORT_INPUT_TYPES.TEXT:
      case INTELLIGENT_IMPORT_INPUT_TYPES.DOCUMENT:
        return this.aiService.analyzeTextImport(
          current.companyId,
          current.id,
          current.rawContentText || current.pastedText || '',
          current.expectedCategory,
        );
      case INTELLIGENT_IMPORT_INPUT_TYPES.CSV:
        return this.aiService.analyzeCsvImport(
          current.companyId,
          current.id,
          current.rawContentText || '',
          current.expectedCategory,
        );
      case INTELLIGENT_IMPORT_INPUT_TYPES.IMAGE:
        if (!current.storageKey || !current.fileMimeType) {
          throw new BadRequestException('Arquivo de imagem nao encontrado para analise');
        }
        return this.aiService.analyzeImageImport(
          current.storageKey,
          current.fileMimeType,
          current.expectedCategory,
        );
      case INTELLIGENT_IMPORT_INPUT_TYPES.PDF:
        if (!current.storageKey || !current.fileMimeType) {
          throw new BadRequestException('Arquivo PDF nao encontrado para analise');
        }
        return this.aiService.analyzePdfImport(
          current.storageKey,
          current.fileMimeType,
          current.expectedCategory,
        );
      default:
        throw new BadRequestException('Tipo de importacao nao suportado');
    }
  }

  private resolveAnalysisStatus(
    inputType: string,
    result: {
      detectedCategory: string;
      confidence: number;
      metrics: unknown[];
      entities: unknown[];
      warnings: string[];
    },
  ) {
    const noUsefulExtraction =
      result.detectedCategory === 'unknown' &&
      result.metrics.length === 0 &&
      result.entities.length === 0 &&
      result.confidence <= 0.25;
    if (
      noUsefulExtraction &&
      (inputType === INTELLIGENT_IMPORT_INPUT_TYPES.IMAGE ||
        inputType === INTELLIGENT_IMPORT_INPUT_TYPES.PDF)
    ) {
      return INTELLIGENT_IMPORT_STATUSES.FAILED;
    }
    return INTELLIGENT_IMPORT_STATUSES.NEEDS_REVIEW;
  }

  private resolveInputType(file: StoredFile) {
    const fileName = file.originalname.toLowerCase();
    if (file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || fileName.endsWith('.csv')) {
      return INTELLIGENT_IMPORT_INPUT_TYPES.CSV;
    }
    if (file.mimetype.startsWith('image/')) {
      return INTELLIGENT_IMPORT_INPUT_TYPES.IMAGE;
    }
    if (file.mimetype === 'application/pdf') {
      return INTELLIGENT_IMPORT_INPUT_TYPES.PDF;
    }
    if (file.mimetype === 'text/plain') {
      return fileName.endsWith('.txt')
        ? INTELLIGENT_IMPORT_INPUT_TYPES.TEXT
        : INTELLIGENT_IMPORT_INPUT_TYPES.DOCUMENT;
    }
    throw new BadRequestException('Tipo de arquivo nao suportado');
  }

  private buildCsvPreview(rawCsvText: string) {
    const records = rawCsvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
    const headerRecord = records[0] || '';
    const delimiter = headerRecord.includes(';') ? ';' : headerRecord.includes('\t') ? '\t' : ',';
    const headers = headerRecord.split(delimiter).map((item) => item.trim().replace(/^"|"$/g, ''));
    return records
      .slice(1, 6)
      .map((row) => row.split(delimiter).map((item) => item.trim().replace(/^"|"$/g, '')))
      .map((values) =>
        headers.reduce<Record<string, string>>((accumulator, header, index) => {
          accumulator[header] = values[index] || '';
          return accumulator;
        }, {}),
      );
  }

  private async storePrivateFile(companyId: string, file: StoredFile) {
    const companyDir = path.join(this.privateStorageRoot, companyId);
    await fs.mkdir(companyDir, { recursive: true });
    const extension = path.extname(file.originalname || '') || this.extensionFromMime(file.mimetype);
    const filePath = path.join(companyDir, `${Date.now()}-${randomUUID()}${extension}`);
    await fs.writeFile(filePath, file.buffer);
    return filePath;
  }

  private extensionFromMime(mimeType: string) {
    if (mimeType === 'application/pdf') return '.pdf';
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/jpeg') return '.jpg';
    if (mimeType === 'image/webp') return '.webp';
    return '.bin';
  }

  private async ensureCompanyAccess(userId: string, companyId: string) {
    const normalizedCompanyId = companyId?.trim();
    if (!userId?.trim()) {
      throw new BadRequestException('Usuario invalido');
    }
    if (!normalizedCompanyId) {
      throw new BadRequestException('companyId nao informado');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: normalizedCompanyId,
        OR: [{ userId }, { users: { some: { id: userId } } }],
      },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Empresa invalida');
    }

    return company.id;
  }

  private async findOwnedImport(companyId: string, importId: string) {
    const item = await this.prisma.intelligentImport.findFirst({
      where: {
        id: importId,
        companyId,
      },
      include: {
        importedMetrics: true,
        importedEntities: true,
      },
    });
    if (!item) {
      throw new NotFoundException('Importacao nao encontrada');
    }
    return item;
  }

  private readExtraction(current: IntelligentImport) {
    return this.aiService.normalizeExtractionResult(current.extractedJson || {
      detectedCategory: 'unknown',
      detectedPlatform: 'unknown',
      period: {
        startDate: null,
        endDate: null,
        label: null,
      },
      confidence: 0.3,
      summary: 'Sem analise concluida.',
      metrics: [],
      entities: [],
      warnings: ['Importacao ainda sem extracao concluida.'],
      needsUserReview: true,
      previewRows: Array.isArray(current.previewJson) ? current.previewJson : undefined,
    });
  }

  private toPublicImport(item: PersistedImport) {
    const extraction = item.extractedJson ? this.aiService.normalizeExtractionResult(item.extractedJson) : null;
    return {
      id: item.id,
      companyId: item.companyId,
      userId: item.userId,
      inputType: item.inputType.toLowerCase(),
      fileName: item.fileName,
      fileMimeType: item.fileMimeType,
      fileSize: item.fileSize,
      expectedCategory: item.expectedCategory || 'auto',
      detectedCategory: extraction?.detectedCategory || this.fromDetectedCategoryEnum(item.detectedCategory),
      detectedPlatform: extraction?.detectedPlatform || item.detectedPlatform || 'unknown',
      detectedPeriodStart: item.detectedPeriodStart?.toISOString() || null,
      detectedPeriodEnd: item.detectedPeriodEnd?.toISOString() || null,
      confidence: Number(item.confidence || 0),
      status: item.status.toLowerCase(),
      aiSummary: item.aiSummary || extraction?.summary || null,
      extracted: extraction,
      warnings: Array.isArray(item.warningsJson) ? item.warningsJson : extraction?.warnings || [],
      previewRows: Array.isArray(item.previewJson) ? item.previewJson : extraction?.previewRows || [],
      importedMetrics: Array.isArray(item.importedMetrics)
        ? item.importedMetrics.map((metric) => this.toPublicImportedMetric(metric))
        : [],
      importedEntities: Array.isArray(item.importedEntities)
        ? item.importedEntities.map((entity) => ({
            id: entity.id,
            companyId: entity.companyId,
            importId: entity.importId,
            entityType: entity.entityType.toLowerCase(),
            normalizedJson: entity.normalizedJson,
            confidence: Number(entity.confidence || 0),
            status: entity.status.toLowerCase(),
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
          }))
        : [],
      errorMessage: item.errorMessage,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      confirmedAt: item.confirmedAt,
      betaCapabilities:
        item.inputType === INTELLIGENT_IMPORT_INPUT_TYPES.IMAGE || item.inputType === INTELLIGENT_IMPORT_INPUT_TYPES.PDF
          ? { dependsOnGemini: true }
          : undefined,
    };
  }

  private toPublicImportedMetric(metric: ImportedMetric) {
    return {
      id: metric.id,
      companyId: metric.companyId,
      importId: metric.importId,
      metricKey: metric.metricKey,
      label: metric.label,
      value: metric.value,
      unit: metric.unit.toLowerCase(),
      currency: metric.currency,
      periodStart: metric.periodStart?.toISOString() || null,
      periodEnd: metric.periodEnd?.toISOString() || null,
      source: metric.source.toLowerCase(),
      platform: metric.platform,
      confidence: Number(metric.confidence || 0),
      status: metric.status.toLowerCase(),
      metadataJson: metric.metadataJson,
      createdAt: metric.createdAt,
      updatedAt: metric.updatedAt,
      sourceLabel: 'Importacao Inteligente',
    };
  }

  private resolveMetricSource(inputType: string) {
    if (inputType === INTELLIGENT_IMPORT_INPUT_TYPES.CSV) {
      return IMPORTED_METRIC_SOURCES.CSV_IMPORT;
    }
    if (inputType === INTELLIGENT_IMPORT_INPUT_TYPES.PDF) {
      return IMPORTED_METRIC_SOURCES.PDF;
    }
    if (inputType === INTELLIGENT_IMPORT_INPUT_TYPES.IMAGE) {
      return IMPORTED_METRIC_SOURCES.SCREENSHOT;
    }
    return IMPORTED_METRIC_SOURCES.MANUAL_TEXT;
  }

  private toDetectedCategoryEnum(value: string | null | undefined) {
    switch ((value || '').toLowerCase()) {
      case 'marketing':
        return INTELLIGENT_IMPORT_CATEGORIES.MARKETING;
      case 'delivery':
        return INTELLIGENT_IMPORT_CATEGORIES.DELIVERY;
      case 'marketplace':
        return INTELLIGENT_IMPORT_CATEGORIES.MARKETPLACE;
      case 'financial':
        return INTELLIGENT_IMPORT_CATEGORIES.FINANCIAL;
      case 'products':
        return INTELLIGENT_IMPORT_CATEGORIES.PRODUCTS;
      case 'customers':
        return INTELLIGENT_IMPORT_CATEGORIES.CUSTOMERS;
      case 'mixed':
        return INTELLIGENT_IMPORT_CATEGORIES.MIXED;
      default:
        return INTELLIGENT_IMPORT_CATEGORIES.UNKNOWN;
    }
  }

  private fromDetectedCategoryEnum(value: string | null | undefined) {
    if (!value) return 'unknown';
    return value.toLowerCase();
  }

  private toMetricUnitEnum(value: string | null | undefined) {
    switch ((value || '').toLowerCase()) {
      case 'currency':
        return IMPORTED_METRIC_UNITS.CURRENCY;
      case 'percentage':
        return IMPORTED_METRIC_UNITS.PERCENTAGE;
      case 'count':
        return IMPORTED_METRIC_UNITS.COUNT;
      case 'ratio':
        return IMPORTED_METRIC_UNITS.RATIO;
      default:
        return IMPORTED_METRIC_UNITS.TEXT;
    }
  }

  private toEntityTypeEnum(value: string | null | undefined) {
    switch ((value || '').toLowerCase()) {
      case 'product':
        return IMPORTED_ENTITY_TYPES.PRODUCT;
      case 'customer':
        return IMPORTED_ENTITY_TYPES.CUSTOMER;
      case 'order':
        return IMPORTED_ENTITY_TYPES.ORDER;
      case 'campaign':
        return IMPORTED_ENTITY_TYPES.CAMPAIGN;
      case 'ad':
        return IMPORTED_ENTITY_TYPES.AD;
      case 'cost':
        return IMPORTED_ENTITY_TYPES.COST;
      default:
        return IMPORTED_ENTITY_TYPES.UNKNOWN;
    }
  }

  private normalizeLowerCategory(value: string | undefined) {
    const normalized = (value || '').trim().toLowerCase();
    return ['marketing', 'delivery', 'marketplace', 'financial', 'products', 'customers', 'mixed', 'unknown'].includes(normalized)
      ? normalized
      : null;
  }

  private normalizeLowerPlatform(value: string | undefined) {
    const normalized = (value || '').trim().toLowerCase();
    return ['utmify', 'meta_ads', 'google_ads', 'ifood', 'mercado_livre', 'shopee', 'amazon', 'generic', 'unknown'].includes(normalized)
      ? normalized
      : null;
  }

  private normalizeLowerUnit(value: string | undefined) {
    const normalized = (value || '').trim().toLowerCase();
    return ['currency', 'percentage', 'count', 'ratio', 'text'].includes(normalized)
      ? normalized
      : 'text';
  }

  private normalizeLowerEntityType(value: string | undefined) {
    const normalized = (value || '').trim().toLowerCase();
    return ['product', 'customer', 'order', 'campaign', 'ad', 'cost', 'unknown'].includes(normalized)
      ? normalized
      : 'unknown';
  }
}
