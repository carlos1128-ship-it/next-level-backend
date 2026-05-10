import { HttpException, HttpStatus } from '@nestjs/common';

export class AIUsageLimitExceededException extends HttpException {
  constructor(
    response:
      | string
      | Record<string, unknown> = 'Limite de IA atingido para este mes.',
    status: HttpStatus = HttpStatus.TOO_MANY_REQUESTS,
  ) {
    super(response, status);
  }
}
