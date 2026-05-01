import { HttpException, HttpStatus } from '@nestjs/common';

export class AIUsageLimitExceededException extends HttpException {
  constructor() {
    super('Limite de IA atingido para este mês.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
