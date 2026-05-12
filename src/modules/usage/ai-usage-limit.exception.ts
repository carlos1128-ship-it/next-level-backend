import { HttpException, HttpStatus } from '@nestjs/common';

export class AIUsageLimitExceededException extends HttpException {
  constructor(
    response:
      | string
      | Record<string, unknown> = 'Você atingiu o limite mensal de IA do seu plano. Faça upgrade para continuar usando este recurso.',
    status: HttpStatus = HttpStatus.TOO_MANY_REQUESTS,
  ) {
    super(response, status);
  }
}
