import { CsvImportsService } from '../src/modules/csv-imports/csv-imports.service';
import {
  CSV_IMPORT_DATA_TYPES,
  CsvImportDataTypeValue,
} from '../src/modules/csv-imports/csv-imports.constants';

type CsvImportJobRecord = {
  id: string;
  companyId: string;
  dataType: CsvImportDataTypeValue;
  fileName: string;
  status: 'UPLOADED' | 'MAPPED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  importedRows: number;
  failedRows: number;
  mappingJson: Record<string, string> | null;
  previewRowsJson: Array<Record<string, string>>;
  rawCsvText: string | null;
  errorJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type CsvImportRowErrorRecord = {
  id: string;
  importJobId: string;
  rowNumber: number;
  errorMessage: string;
  rawRowJson: Record<string, string>;
  createdAt: Date;
};

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function createFakePrisma() {
  const state = {
    companies: [
      { id: 'company-a', userId: 'user-a' },
      { id: 'company-b', userId: 'user-b' },
    ],
    jobs: [] as CsvImportJobRecord[],
    rowErrors: [] as CsvImportRowErrorRecord[],
    sales: [] as any[],
    products: [] as any[],
    customers: [] as any[],
    costs: [] as any[],
    adSpends: [] as any[],
  };

  return {
    state,
    prisma: {
      company: {
        findFirst: async ({ where }: any) => {
          return (
            state.companies.find(
              (company) =>
                company.id === where.id &&
                where.OR.some((rule: any) => rule.userId === company.userId || rule.users?.some?.id === company.userId),
            ) || null
          );
        },
      },
      csvImportJob: {
        create: async ({ data }: any) => {
          const now = new Date();
          const job: CsvImportJobRecord = {
            id: `job-${state.jobs.length + 1}`,
            companyId: data.companyId,
            dataType: data.dataType,
            fileName: data.fileName,
            status: data.status,
            totalRows: data.totalRows,
            importedRows: data.importedRows,
            failedRows: data.failedRows,
            mappingJson: data.mappingJson ?? null,
            previewRowsJson: data.previewRowsJson ?? [],
            rawCsvText: data.rawCsvText ?? null,
            errorJson: data.errorJson ?? null,
            createdAt: now,
            updatedAt: now,
          };
          state.jobs.push(job);
          return job;
        },
        update: async ({ where, data, include }: any) => {
          const current = state.jobs.find((job) => job.id === where.id);
          if (!current) throw new Error('job not found');
          Object.assign(current, data, { updatedAt: new Date() });
          if (include?.rowErrors) {
            return {
              ...current,
              rowErrors: state.rowErrors
                .filter((item) => item.importJobId === current.id)
                .sort((a, b) => a.rowNumber - b.rowNumber),
            };
          }
          return current;
        },
        findFirst: async ({ where, include }: any) => {
          const current =
            state.jobs.find((job) => job.id === where.id && job.companyId === where.companyId) || null;
          if (!current) return null;
          if (include?.rowErrors) {
            return {
              ...current,
              rowErrors: state.rowErrors
                .filter((item) => item.importJobId === current.id)
                .sort((a, b) => a.rowNumber - b.rowNumber),
            };
          }
          return current;
        },
        findMany: async ({ where, include }: any) => {
          const jobs = state.jobs
            .filter((job) => job.companyId === where.companyId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          if (include?.rowErrors) {
            return jobs.map((job) => ({
              ...job,
              rowErrors: state.rowErrors
                .filter((item) => item.importJobId === job.id)
                .sort((a, b) => a.rowNumber - b.rowNumber),
            }));
          }
          return jobs;
        },
      },
      csvImportRowError: {
        deleteMany: async ({ where }: any) => {
          const before = state.rowErrors.length;
          state.rowErrors = state.rowErrors.filter((item) => item.importJobId !== where.importJobId);
          return { count: before - state.rowErrors.length };
        },
        createMany: async ({ data }: any) => {
          const rows = data.map((item: any, index: number) => ({
            id: `row-error-${state.rowErrors.length + index + 1}`,
            importJobId: item.importJobId,
            rowNumber: item.rowNumber,
            errorMessage: item.errorMessage,
            rawRowJson: item.rawRowJson,
            createdAt: new Date(),
          }));
          state.rowErrors.push(...rows);
          return { count: rows.length };
        },
      },
      sale: {
        findFirst: async ({ where }: any) =>
          state.sales.find(
            (sale) =>
              sale.companyId === where.companyId &&
              sale.amount === Number(where.amount) &&
              sale.productName === where.productName &&
              sale.occurredAt.getTime() === where.occurredAt.getTime(),
          ) || null,
        create: async ({ data }: any) => {
          state.sales.push({
            ...data,
            amount: Number(data.amount),
          });
          return data;
        },
      },
      product: {
        findFirst: async ({ where }: any) =>
          state.products.find(
            (product) =>
              product.companyId === where.companyId &&
              where.OR.some((rule: any) => (!rule.name || rule.name === product.name) && (!rule.sku || rule.sku === product.sku)),
          ) || null,
        create: async ({ data }: any) => {
          state.products.push(data);
          return data;
        },
      },
      customer: {
        findFirst: async ({ where }: any) =>
          state.customers.find(
            (customer) =>
              customer.companyId === where.companyId &&
              where.OR.some(
                (rule: any) =>
                  (!rule.name || rule.name === customer.name) &&
                  (!rule.email || rule.email === customer.email) &&
                  (!rule.phone || rule.phone === customer.phone),
              ),
          ) || null,
        create: async ({ data }: any) => {
          state.customers.push(data);
          return data;
        },
      },
      operationalCost: {
        findFirst: async ({ where }: any) =>
          state.costs.find(
            (cost) =>
              cost.companyId === where.companyId &&
              cost.name === where.name &&
              cost.amount === Number(where.amount) &&
              cost.date.getTime() === where.date.getTime(),
          ) || null,
        create: async ({ data }: any) => {
          state.costs.push({
            ...data,
            amount: Number(data.amount),
          });
          return data;
        },
      },
      adSpend: {
        findFirst: async ({ where }: any) =>
          state.adSpends.find(
            (adSpend) =>
              adSpend.companyId === where.companyId &&
              adSpend.amount === Number(where.amount) &&
              adSpend.source === where.source &&
              adSpend.spentAt.getTime() === where.spentAt.getTime(),
          ) || null,
        create: async ({ data }: any) => {
          state.adSpends.push({
            ...data,
            amount: Number(data.amount),
          });
          return data;
        },
      },
    },
  };
}

async function main() {
  const fake = createFakePrisma();
  const service = new CsvImportsService(fake.prisma as any);

  const companyAJob = await service.uploadCsv('user-a', 'company-a', CSV_IMPORT_DATA_TYPES.SALES, {
    buffer: Buffer.from('date,amount,product\n2026-04-01,100,Plano Pro\n'),
    originalname: 'sales-a.csv',
    mimetype: 'text/csv',
    size: 40,
  });
  const companyBJob = await service.uploadCsv('user-b', 'company-b', CSV_IMPORT_DATA_TYPES.CUSTOMERS, {
    buffer: Buffer.from('name,email\nCliente B,b@test.local\n'),
    originalname: 'customers-b.csv',
    mimetype: 'text/csv',
    size: 40,
  });

  const jobsForA = await service.listJobs('user-a', 'company-a');
  assert(jobsForA.length === 1 && jobsForA[0].id === companyAJob.id, 'A. Empresa A viu job de outra empresa');
  const jobsForB = await service.listJobs('user-b', 'company-b');
  assert(jobsForB.length === 1 && jobsForB[0].id === companyBJob.id, 'A. Empresa B viu job de outra empresa');

  await service.saveMapping('user-a', 'company-a', companyAJob.id, {
    date: 'date',
    amount: 'amount',
    product: 'product',
  });
  const mappedJob = await service.getJob('user-a', 'company-a', companyAJob.id);
  assert(mappedJob.status === 'mapped', 'B. Job CSV nao foi criado/mapeado');

  let invalidMappingRejected = false;
  try {
    await service.saveMapping('user-b', 'company-b', companyBJob.id, {
      email: 'email',
    });
  } catch {
    invalidMappingRejected = true;
  }
  assert(invalidMappingRejected, 'C. Mapeamento invalido nao foi rejeitado');

  const costJob = await service.uploadCsv('user-a', 'company-a', CSV_IMPORT_DATA_TYPES.COSTS, {
    buffer: Buffer.from('name,amount,date\nServidor,120,2026-04-01\nFrete,abc,2026-04-02\n'),
    originalname: 'costs.csv',
    mimetype: 'text/csv',
    size: 80,
  });
  await service.saveMapping('user-a', 'company-a', costJob.id, {
    name: 'name',
    amount: 'amount',
    date: 'date',
  });
  const importedCostJob = await service.confirmImport('user-a', 'company-a', costJob.id);
  assert(importedCostJob.importedRows === 1 && importedCostJob.failedRows === 1, 'D. Falhas por linha nao foram registradas');
  assert(importedCostJob.rowErrors.length === 1 && importedCostJob.rowErrors[0].rowNumber === 3, 'D. Row error nao foi salvo');

  assert(companyAJob.status === 'uploaded', 'E. Upload inicial apareceu como concluido sem confirmacao');

  console.log('CSV import checks A-E passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
