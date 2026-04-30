import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CsvImportJob,
  CsvImportRowError,
  Prisma,
  SaleChannel,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CSV_IMPORT_DATA_TYPES,
  CSV_IMPORT_STATUSES,
  CsvImportDataTypeValue,
} from './csv-imports.constants';

type CsvRow = Record<string, string>;
type CsvFieldConfig = {
  required: string[];
  optional: string[];
};

type PersistedCsvJob = CsvImportJob & {
  rowErrors?: CsvImportRowError[];
};

type SaleImportRow = {
  occurredAt: Date;
  amount: number;
  productName: string | null;
};

type ProductImportRow = {
  name: string;
  sku: string | null;
  category: string | null;
  price: number;
  cost: number | null;
};

type CustomerImportRow = {
  name: string;
  email: string | null;
  phone: string | null;
};

type CostImportRow = {
  name: string;
  category: string | null;
  amount: number;
  date: Date;
};

type AdSpendImportRow = {
  amount: number;
  spentAt: Date;
  source: string;
  campaign: string | null;
};

type OrderImportRow = {
  orderId: string | null;
  occurredAt: Date;
  amount: number;
  customer: string | null;
  status: string | null;
  source: string | null;
};

type NormalizedImportRow =
  | SaleImportRow
  | ProductImportRow
  | CustomerImportRow
  | CostImportRow
  | AdSpendImportRow
  | OrderImportRow;

const CSV_FIELD_CONFIG: Record<CsvImportDataTypeValue, CsvFieldConfig> = {
  [CSV_IMPORT_DATA_TYPES.SALES]: {
    required: ['date', 'amount'],
    optional: ['product', 'customer', 'status', 'source'],
  },
  [CSV_IMPORT_DATA_TYPES.PRODUCTS]: {
    required: ['name', 'price'],
    optional: ['sku', 'category', 'cost'],
  },
  [CSV_IMPORT_DATA_TYPES.CUSTOMERS]: {
    required: ['name'],
    optional: ['email', 'phone'],
  },
  [CSV_IMPORT_DATA_TYPES.COSTS]: {
    required: ['name', 'amount', 'date'],
    optional: ['category'],
  },
  [CSV_IMPORT_DATA_TYPES.AD_SPEND]: {
    required: ['amount', 'date'],
    optional: ['source', 'campaign'],
  },
  [CSV_IMPORT_DATA_TYPES.ORDERS]: {
    required: ['date', 'amount'],
    optional: ['orderId', 'customer', 'status', 'source'],
  },
};

@Injectable()
export class CsvImportsService {
  constructor(private readonly prisma: PrismaService) {}

  async uploadCsv(
    userId: string,
    companyId: string,
    dataType: CsvImportDataTypeValue,
    file?: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ) {
    await this.ensureCompanyAccess(userId, companyId);

    if (!file?.buffer?.length) {
      throw new BadRequestException('Arquivo CSV obrigatorio');
    }

    const fileName = file.originalname?.trim() || 'import.csv';
    if (!fileName.toLowerCase().endsWith('.csv')) {
      throw new BadRequestException('Envie um arquivo .csv');
    }

    const rawCsvText = file.buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!rawCsvText) {
      throw new BadRequestException('Arquivo CSV vazio');
    }

    const parsed = this.parseCsv(rawCsvText);
    if (!parsed.headers.length) {
      throw new BadRequestException('Cabecalho CSV nao encontrado');
    }
    if (!parsed.rows.length) {
      throw new BadRequestException('CSV sem linhas para importar');
    }

    const job = await this.prisma.csvImportJob.create({
      data: {
        companyId,
        dataType,
        fileName,
        status: CSV_IMPORT_STATUSES.UPLOADED,
        totalRows: parsed.rows.length,
        importedRows: 0,
        failedRows: 0,
        previewRowsJson: parsed.rows.slice(0, 5),
        rawCsvText,
      },
    });

    return this.toPublicJob(job, {
      previewRows: parsed.rows.slice(0, 5),
      headers: parsed.headers,
      rowErrors: [],
    });
  }

  async saveMapping(
    userId: string,
    companyId: string,
    jobId: string,
    mappingInput: Record<string, string>,
  ) {
    await this.ensureCompanyAccess(userId, companyId);
    const job = await this.findOwnedJob(companyId, jobId);
    const headers = this.extractHeaders(job);
    const mapping = this.normalizeMapping(mappingInput);
    this.validateMapping(job.dataType, headers, mapping);

    const updated = (await this.prisma.csvImportJob.update({
      where: { id: job.id },
      data: {
        mappingJson: mapping,
        status: CSV_IMPORT_STATUSES.MAPPED,
        errorJson: Prisma.DbNull,
      },
      include: {
        rowErrors: {
          orderBy: { rowNumber: 'asc' },
        },
      },
    })) as PersistedCsvJob;

    return this.toPublicJob(updated, {
      headers,
      previewRows: this.extractPreviewRows(updated),
      rowErrors: updated.rowErrors || [],
    });
  }

  async confirmImport(userId: string, companyId: string, jobId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const job = await this.findOwnedJob(companyId, jobId);
    const headers = this.extractHeaders(job);
    const rows = this.parseCsv(job.rawCsvText || '').rows;
    const mapping = this.extractMapping(job);
    this.validateMapping(job.dataType, headers, mapping);

    await this.prisma.csvImportJob.update({
      where: { id: job.id },
      data: {
        status: CSV_IMPORT_STATUSES.PROCESSING,
        importedRows: 0,
        failedRows: 0,
        errorJson: Prisma.DbNull,
      },
    });
    await this.prisma.csvImportRowError.deleteMany({
      where: { importJobId: job.id },
    });

    const seenFingerprints = new Set<string>();
    const rowErrors: Array<{ rowNumber: number; errorMessage: string; rawRowJson: CsvRow }> = [];
    let importedRows = 0;

    for (const [index, row] of rows.entries()) {
      try {
        const normalizedRow = this.normalizeRow(job.dataType, row, mapping);
        const fingerprint = this.buildFingerprint(job.dataType, normalizedRow);
        if (seenFingerprints.has(fingerprint)) {
          throw new BadRequestException('Linha duplicada dentro do arquivo');
        }
        seenFingerprints.add(fingerprint);
        await this.persistRow(companyId, userId, job.dataType, normalizedRow);
        importedRows += 1;
      } catch (error) {
        rowErrors.push({
          rowNumber: index + 2,
          errorMessage: this.extractErrorMessage(error),
          rawRowJson: row,
        });
      }
    }

    if (rowErrors.length) {
      await this.prisma.csvImportRowError.createMany({
        data: rowErrors.map((item) => ({
          importJobId: job.id,
          rowNumber: item.rowNumber,
          errorMessage: item.errorMessage,
          rawRowJson: item.rawRowJson,
        })),
      });
    }

    const finalStatus =
      importedRows > 0 ? CSV_IMPORT_STATUSES.COMPLETED : CSV_IMPORT_STATUSES.FAILED;
    const failedRows = rowErrors.length;

    const updated = (await this.prisma.csvImportJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        importedRows,
        failedRows,
        errorJson:
          failedRows > 0
            ? {
                message:
                  finalStatus === CSV_IMPORT_STATUSES.COMPLETED
                    ? 'Importacao concluida com falhas'
                    : 'Importacao falhou',
                rowErrors: rowErrors.slice(0, 10),
              }
            : Prisma.DbNull,
      },
      include: {
        rowErrors: {
          orderBy: { rowNumber: 'asc' },
        },
      },
    })) as PersistedCsvJob;

    return this.toPublicJob(updated, {
      headers,
      previewRows: this.extractPreviewRows(updated),
      rowErrors: updated.rowErrors || [],
    });
  }

  async getJob(userId: string, companyId: string, jobId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const job = (await this.prisma.csvImportJob.findFirst({
      where: {
        id: jobId,
        companyId,
      },
      include: {
        rowErrors: {
          orderBy: { rowNumber: 'asc' },
        },
      },
    })) as PersistedCsvJob | null;

    if (!job) {
      throw new NotFoundException('Importacao CSV nao encontrada');
    }

    return this.toPublicJob(job, {
      headers: this.extractHeaders(job),
      previewRows: this.extractPreviewRows(job),
      rowErrors: job.rowErrors || [],
    });
  }

  async listJobs(userId: string, companyId: string) {
    await this.ensureCompanyAccess(userId, companyId);
    const jobs = (await this.prisma.csvImportJob.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        rowErrors: {
          orderBy: { rowNumber: 'asc' },
        },
      },
    })) as PersistedCsvJob[];

    return jobs.map((job) =>
      this.toPublicJob(job, {
        headers: this.extractHeaders(job),
        previewRows: this.extractPreviewRows(job),
        rowErrors: job.rowErrors || [],
      }),
    );
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

  private async findOwnedJob(companyId: string, jobId: string) {
    const job = await this.prisma.csvImportJob.findFirst({
      where: {
        id: jobId,
        companyId,
      },
    });

    if (!job) {
      throw new NotFoundException('Importacao CSV nao encontrada');
    }

    return job;
  }

  private parseCsv(rawCsvText: string) {
    const normalized = rawCsvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!normalized) {
      return { headers: [], rows: [] as CsvRow[] };
    }

    const records = this.splitCsvRecords(normalized).filter((record) => record.trim().length > 0);
    if (!records.length) {
      return { headers: [], rows: [] as CsvRow[] };
    }

    const delimiter = this.detectDelimiter(records[0]);
    const headers = this.normalizeHeaders(this.parseCsvRecord(records[0], delimiter));
    const rows = records
      .slice(1)
      .map((record) => this.parseCsvRecord(record, delimiter))
      .map((values) => this.buildRow(headers, values))
      .filter((row) => Object.values(row).some((value) => value.trim().length > 0));

    return { headers, rows };
  }

  private splitCsvRecords(content: string): string[] {
    const records: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < content.length; index += 1) {
      const char = content[index];
      const next = content[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === '\n' && !inQuotes) {
        records.push(current);
        current = '';
        continue;
      }

      current += char;
    }

    if (current.length > 0) {
      records.push(current);
    }

    return records;
  }

  private detectDelimiter(headerRecord: string) {
    const delimiters = [',', ';', '\t'];
    let selected = ',';
    let highestScore = -1;

    for (const delimiter of delimiters) {
      const score = this.parseCsvRecord(headerRecord, delimiter).length;
      if (score > highestScore) {
        selected = delimiter;
        highestScore = score;
      }
    }

    return selected;
  }

  private parseCsvRecord(record: string, delimiter: string) {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < record.length; index += 1) {
      const char = record[index];
      const next = record[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === delimiter && !inQuotes) {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    values.push(current.trim());
    return values;
  }

  private normalizeHeaders(headers: string[]) {
    const seen = new Map<string, number>();

    return headers.map((header, index) => {
      const base = header.trim() || `coluna_${index + 1}`;
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      return count === 1 ? base : `${base}_${count}`;
    });
  }

  private buildRow(headers: string[], values: string[]): CsvRow {
    return headers.reduce<CsvRow>((accumulator, header, index) => {
      accumulator[header] = (values[index] || '').trim();
      return accumulator;
    }, {});
  }

  private normalizeMapping(mappingInput: Record<string, string>) {
    return Object.entries(mappingInput || {}).reduce<Record<string, string>>(
      (accumulator, [targetField, sourceColumn]) => {
        const normalizedTarget = targetField.trim();
        const normalizedSource = sourceColumn?.trim();
        if (normalizedTarget && normalizedSource) {
          accumulator[normalizedTarget] = normalizedSource;
        }
        return accumulator;
      },
      {},
    );
  }

  private validateMapping(
    dataType: CsvImportDataTypeValue,
    headers: string[],
    mapping: Record<string, string>,
  ) {
    const config = CSV_FIELD_CONFIG[dataType];
    const missingFields = config.required.filter((field) => !mapping[field]);
    if (missingFields.length) {
      throw new BadRequestException(
        `Mapeamento incompleto: ${missingFields.join(', ')}`,
      );
    }

    const headerSet = new Set(headers);
    const invalidColumns = Object.values(mapping).filter((column) => !headerSet.has(column));
    if (invalidColumns.length) {
      throw new BadRequestException(
        `Colunas invalidas no mapeamento: ${invalidColumns.join(', ')}`,
      );
    }

    const duplicatedSources = Object.values(mapping).filter(
      (column, index, values) => values.indexOf(column) !== index,
    );
    if (duplicatedSources.length) {
      throw new BadRequestException(
        `Uma mesma coluna nao pode alimentar mais de um campo: ${[
          ...new Set(duplicatedSources),
        ].join(', ')}`,
      );
    }
  }

  private normalizeRow(
    dataType: CsvImportDataTypeValue,
    row: CsvRow,
    mapping: Record<string, string>,
  ): NormalizedImportRow {
    const read = (field: string) => row[mapping[field]] || '';

    switch (dataType) {
      case CSV_IMPORT_DATA_TYPES.SALES:
        return {
          occurredAt: this.parseDate(read('date'), 'date'),
          amount: this.parseNumber(read('amount'), 'amount'),
          productName: this.parseOptionalString(read('product')),
        };
      case CSV_IMPORT_DATA_TYPES.PRODUCTS:
        return {
          name: this.parseRequiredString(read('name'), 'name'),
          sku: this.parseOptionalString(read('sku')),
          category: this.parseOptionalString(read('category')),
          price: this.parseNumber(read('price'), 'price'),
          cost: this.parseOptionalNumber(read('cost')),
        };
      case CSV_IMPORT_DATA_TYPES.CUSTOMERS:
        return {
          name: this.parseRequiredString(read('name'), 'name'),
          email: this.parseOptionalString(read('email')),
          phone: this.parseOptionalString(read('phone')),
        };
      case CSV_IMPORT_DATA_TYPES.COSTS:
        return {
          name: this.parseRequiredString(read('name'), 'name'),
          category: this.parseOptionalString(read('category')),
          amount: this.parseNumber(read('amount'), 'amount'),
          date: this.parseDate(read('date'), 'date'),
        };
      case CSV_IMPORT_DATA_TYPES.AD_SPEND:
        return {
          amount: this.parseNumber(read('amount'), 'amount'),
          spentAt: this.parseDate(read('date'), 'date'),
          source: this.parseOptionalString(read('source')) || 'manual_csv',
          campaign: this.parseOptionalString(read('campaign')),
        };
      case CSV_IMPORT_DATA_TYPES.ORDERS:
        return {
          orderId: this.parseOptionalString(read('orderId')),
          occurredAt: this.parseDate(read('date'), 'date'),
          amount: this.parseNumber(read('amount'), 'amount'),
          customer: this.parseOptionalString(read('customer')),
          status: this.parseOptionalString(read('status')),
          source: this.parseOptionalString(read('source')),
        };
      default:
        throw new BadRequestException('Tipo de importacao nao suportado');
    }
  }

  private buildFingerprint(dataType: CsvImportDataTypeValue, row: NormalizedImportRow) {
    return `${dataType}:${JSON.stringify(row)}`;
  }

  private async persistRow(
    companyId: string,
    userId: string,
    dataType: CsvImportDataTypeValue,
    row: NormalizedImportRow,
  ) {
    switch (dataType) {
      case CSV_IMPORT_DATA_TYPES.SALES:
        return this.persistSale(companyId, userId, row as SaleImportRow);
      case CSV_IMPORT_DATA_TYPES.PRODUCTS:
        return this.persistProduct(companyId, row as ProductImportRow);
      case CSV_IMPORT_DATA_TYPES.CUSTOMERS:
        return this.persistCustomer(companyId, row as CustomerImportRow);
      case CSV_IMPORT_DATA_TYPES.COSTS:
        return this.persistCost(companyId, row as CostImportRow);
      case CSV_IMPORT_DATA_TYPES.AD_SPEND:
        return this.persistAdSpend(companyId, row as AdSpendImportRow);
      case CSV_IMPORT_DATA_TYPES.ORDERS:
        return { rawOnly: true, row };
      default:
        throw new BadRequestException('Tipo de importacao nao suportado');
    }
  }

  private async persistSale(companyId: string, userId: string, row: SaleImportRow) {
    const amount = new Prisma.Decimal(row.amount);
    const existing = await this.prisma.sale.findFirst({
      where: {
        companyId,
        occurredAt: row.occurredAt,
        amount,
        productName: row.productName,
      },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Venda duplicada para esta empresa');
    }

    return this.prisma.sale.create({
      data: {
        companyId,
        userId,
        amount,
        productName: row.productName,
        category: null,
        channel: SaleChannel.manual,
        occurredAt: row.occurredAt,
      },
    });
  }

  private async persistProduct(companyId: string, row: ProductImportRow) {
    const existing = await this.prisma.product.findFirst({
      where: {
        companyId,
        OR: row.sku
          ? [{ sku: row.sku }, { name: row.name }]
          : [{ name: row.name }],
      },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Produto duplicado para esta empresa');
    }

    return this.prisma.product.create({
      data: {
        companyId,
        name: row.name,
        sku: row.sku,
        category: row.category,
        price: new Prisma.Decimal(row.price),
        cost: row.cost !== null ? new Prisma.Decimal(row.cost) : null,
      },
    });
  }

  private async persistCustomer(companyId: string, row: CustomerImportRow) {
    const where: Prisma.CustomerWhereInput = {
      companyId,
      OR: [
        row.email ? { email: row.email } : undefined,
        row.phone ? { phone: row.phone } : undefined,
        !row.email && !row.phone ? { name: row.name } : undefined,
      ].filter(Boolean) as Prisma.CustomerWhereInput[],
    };

    const existing = await this.prisma.customer.findFirst({
      where,
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Cliente duplicado para esta empresa');
    }

    return this.prisma.customer.create({
      data: {
        companyId,
        name: row.name,
        email: row.email,
        phone: row.phone,
      },
    });
  }

  private async persistCost(companyId: string, row: CostImportRow) {
    const amount = new Prisma.Decimal(row.amount);
    const existing = await this.prisma.operationalCost.findFirst({
      where: {
        companyId,
        name: row.name,
        amount,
        date: row.date,
      },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Custo duplicado para esta empresa');
    }

    return this.prisma.operationalCost.create({
      data: {
        companyId,
        name: row.name,
        category: row.category,
        amount,
        date: row.date,
      },
    });
  }

  private async persistAdSpend(companyId: string, row: AdSpendImportRow) {
    const amount = new Prisma.Decimal(row.amount);
    const existing = await this.prisma.adSpend.findFirst({
      where: {
        companyId,
        amount,
        spentAt: row.spentAt,
        source: row.source,
      },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Investimento em anuncio duplicado para esta empresa');
    }

    return this.prisma.adSpend.create({
      data: {
        companyId,
        amount,
        spentAt: row.spentAt,
        source: row.source,
        metadata: row.campaign ? { campaign: row.campaign } : undefined,
      },
    });
  }

  private parseRequiredString(value: string, field: string) {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`${field} obrigatorio`);
    }
    return normalized;
  }

  private parseOptionalString(value: string) {
    const normalized = value.trim();
    return normalized || null;
  }

  private parseNumber(value: string, field: string) {
    const raw = value.trim();
    const commaIndex = raw.lastIndexOf(',');
    const dotIndex = raw.lastIndexOf('.');
    let normalized = raw;

    if (commaIndex >= 0 && dotIndex >= 0) {
      normalized =
        commaIndex > dotIndex
          ? raw.replace(/\./g, '').replace(',', '.')
          : raw.replace(/,/g, '');
    } else if (commaIndex >= 0) {
      normalized = raw.replace(',', '.');
    }

    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) {
      throw new BadRequestException(`${field} invalido`);
    }
    return numeric;
  }

  private parseOptionalNumber(value: string) {
    const normalized = value.trim();
    if (!normalized) return null;
    return this.parseNumber(normalized, 'value');
  }

  private parseDate(value: string, field: string) {
    const normalized = value.trim();
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} invalido`);
    }
    return parsed;
  }

  private extractHeaders(job: CsvImportJob) {
    const previewRows = this.extractPreviewRows(job);
    if (!previewRows.length) return [];
    return Object.keys(previewRows[0]);
  }

  private extractPreviewRows(job: CsvImportJob) {
    const previewRowsJson = job.previewRowsJson;
    if (!Array.isArray(previewRowsJson)) {
      return [] as CsvRow[];
    }

    return previewRowsJson.filter((row): row is CsvRow => {
      return Boolean(row) && typeof row === 'object' && !Array.isArray(row);
    });
  }

  private extractMapping(job: CsvImportJob) {
    const mappingJson = job.mappingJson;
    if (!mappingJson || typeof mappingJson !== 'object' || Array.isArray(mappingJson)) {
      throw new BadRequestException('Mapeamento ainda nao configurado');
    }

    return Object.entries(mappingJson).reduce<Record<string, string>>(
      (accumulator, [targetField, sourceColumn]) => {
        if (typeof sourceColumn === 'string' && sourceColumn.trim()) {
          accumulator[targetField] = sourceColumn.trim();
        }
        return accumulator;
      },
      {},
    );
  }

  private toPublicJob(
    job: PersistedCsvJob,
    extras: {
      headers: string[];
      previewRows: CsvRow[];
      rowErrors: CsvImportRowError[];
    },
  ) {
    const config = CSV_FIELD_CONFIG[job.dataType];

    return {
      id: job.id,
      companyId: job.companyId,
      dataType: job.dataType,
      fileName: job.fileName,
      status: job.status.toLowerCase(),
      totalRows: job.totalRows,
      importedRows: job.importedRows,
      failedRows: job.failedRows,
      mapping: job.mappingJson,
      headers: extras.headers,
      previewRows: extras.previewRows,
      requiredFields: config.required,
      optionalFields: config.optional,
      rowErrors: extras.rowErrors.map((item) => ({
        id: item.id,
        rowNumber: item.rowNumber,
        errorMessage: item.errorMessage,
        rawRowJson: item.rawRowJson,
      })),
      rawStorageMode:
        job.dataType === CSV_IMPORT_DATA_TYPES.ORDERS ? 'raw_only' : 'internal_records',
      errorJson: job.errorJson,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private extractErrorMessage(error: unknown) {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string') {
        return response;
      }
      if (
        response &&
        typeof response === 'object' &&
        'message' in response &&
        typeof response.message === 'string'
      ) {
        return response.message;
      }
    }

    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }

    return 'Falha ao importar linha';
  }
}
