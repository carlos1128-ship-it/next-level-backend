import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isPrismaKnown = exception instanceof Prisma.PrismaClientKnownRequestError;
    const isPrismaValidation = exception instanceof Prisma.PrismaClientValidationError;
    const isPrismaInit = exception instanceof Prisma.PrismaClientInitializationError;
    const isPrismaRustPanic = exception instanceof Prisma.PrismaClientRustPanicError;

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : isPrismaKnown || isPrismaValidation
        ? HttpStatus.BAD_REQUEST
        : isPrismaInit || isPrismaRustPanic
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof HttpException
      ? exception.getResponse()
      : isPrismaInit
        ? { message: 'Banco de dados indisponível no momento' }
        : isPrismaRustPanic
          ? { message: 'Falha crítica no banco de dados' }
          : isPrismaValidation
            ? { message: 'Dados inválidos para operação no banco' }
            : isPrismaKnown
              ? { message: this.mapPrismaKnownError(exception) }
              : { message: 'Erro interno do servidor' };

    const body =
      typeof message === 'object' && message !== null
        ? { ...(message as object), statusCode: status }
        : { message, statusCode: status };

    this.logger.error(
      `${request.method} ${request.url} - ${status}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json(body);
  }

  private mapPrismaKnownError(error: Prisma.PrismaClientKnownRequestError): string {
    switch (error.code) {
      case 'P2002':
        return 'Registro duplicado (violação de unicidade)';
      case 'P2003':
        return 'Referência inválida entre entidades';
      case 'P2025':
        return 'Registro não encontrado';
      default:
        return 'Erro de persistência no banco';
    }
  }
}
