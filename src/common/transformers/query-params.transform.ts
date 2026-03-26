import { Transform } from 'class-transformer';

/** Query string -> inteiro opcional >= 1; inválido ou vazio -> undefined */
export function TransformOptionalPage() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 1) return undefined;
    return n;
  });
}

/** Query string -> inteiro opcional 1..max; inválido -> undefined */
export function TransformOptionalLimit(max = 100) {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 1) return undefined;
    return Math.min(n, max);
  });
}

/** Query string -> número opcional >= 0 */
export function TransformOptionalNonNegativeNumber() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(String(value));
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  });
}
