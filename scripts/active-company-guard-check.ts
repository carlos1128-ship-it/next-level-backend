import assert from 'assert';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ActiveCompanyGuard } from '../src/common/guards/active-company.guard';

type CompanyRecord = {
  id: string;
  userId: string;
  users?: Array<{ id: string }>;
};

function createPrisma(companies: CompanyRecord[]) {
  const canAccess = (company: CompanyRecord, userId: string) =>
    company.userId === userId || Boolean(company.users?.some((user) => user.id === userId));

  return {
    company: {
      findFirst: async ({ where }: any) => {
        const userId =
          where.OR?.find((item: any) => typeof item.userId === 'string')?.userId ||
          where.OR?.find((item: any) => item.users?.some?.id)?.users?.some?.id ||
          '';
        return companies.find((company) => company.id === where.id && canAccess(company, userId)) || null;
      },
      count: async ({ where }: any) => {
        const userId =
          where.OR?.find((item: any) => typeof item.userId === 'string')?.userId ||
          where.OR?.find((item: any) => item.users?.some?.id)?.users?.some?.id ||
          '';
        return companies.filter((company) => canAccess(company, userId)).length;
      },
    },
  };
}

function createContext(request: Record<string, any>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as any;
}

async function main() {
  const guard = new ActiveCompanyGuard(
    createPrisma([
      { id: 'companyA', userId: 'userA' },
      { id: 'companyB', userId: 'ownerB', users: [{ id: 'userA' }] },
    ]) as any,
  );

  const multiCompanyRequest = {
    path: '/api/intelligent-imports',
    query: { companyId: 'companyB' },
    body: {},
    params: {},
    user: { id: 'userA', companyId: 'companyA' },
  };
  assert.equal(await guard.canActivate(createContext(multiCompanyRequest)), true);
  assert.equal(multiCompanyRequest.user.companyId, 'companyB');
  assert.equal(multiCompanyRequest.query.companyId, 'companyB');

  const defaultCompanyRequest = {
    path: '/api/intelligent-imports',
    query: {},
    body: {},
    params: {},
    user: { id: 'userA', companyId: 'companyA' },
  };
  assert.equal(await guard.canActivate(createContext(defaultCompanyRequest)), true);
  assert.equal(defaultCompanyRequest.user.companyId, 'companyA');

  await assert.rejects(
    () =>
      guard.canActivate(
        createContext({
          path: '/api/intelligent-imports',
          query: { companyId: 'companyC' },
          body: {},
          params: {},
          user: { id: 'userA', companyId: 'companyA' },
        }),
      ),
    (error: unknown) => error instanceof ForbiddenException,
  );

  await assert.rejects(
    () =>
      guard.canActivate(
        createContext({
          path: '/api/intelligent-imports',
          query: {},
          body: {},
          params: {},
          user: { id: 'userA', companyId: null },
        }),
      ),
    (error: unknown) => error instanceof BadRequestException,
  );

  console.log('Active company guard checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
