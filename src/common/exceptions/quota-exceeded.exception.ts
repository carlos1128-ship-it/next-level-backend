import { HttpException, HttpStatus } from '@nestjs/common';

export class QuotaExceededException extends HttpException {
  constructor(message = 'Limite de uso da IA atingido para este ciclo') {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
