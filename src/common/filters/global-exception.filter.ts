import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  timestamp: string;
  path: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const isPrismaKnown =
      exception instanceof Prisma.PrismaClientKnownRequestError;
    const isPrismaValidation =
      exception instanceof Prisma.PrismaClientValidationError;
    const isPrismaInit =
      exception instanceof Prisma.PrismaClientInitializationError;
    const isPrismaRustPanic =
      exception instanceof Prisma.PrismaClientRustPanicError;
    const isAxiosError = axios.isAxiosError(exception);

    const originalStatus = isHttpException
      ? exception.getStatus()
      : isPrismaKnown || isPrismaValidation
        ? HttpStatus.BAD_REQUEST
        : isPrismaInit || isPrismaRustPanic || isAxiosError
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.INTERNAL_SERVER_ERROR;

    const statusCode = isHttpException
      ? originalStatus
      : originalStatus >= 500
        ? isPrismaInit || isPrismaRustPanic || isAxiosError
          ? HttpStatus.FAILED_DEPENDENCY
          : HttpStatus.BAD_GATEWAY
        : originalStatus;

    const body = this.buildBody(
      exception,
      statusCode,
      request.originalUrl || request.url,
    );

    const logPayload = {
      event: 'http.exception',
      method: request.method,
      path: request.originalUrl || request.url,
      originalStatus,
      statusCode,
      message: body.message,
      exceptionName:
        exception instanceof Error ? exception.name : 'UnknownException',
      timestamp: body.timestamp,
    };

    this.logger.error(
      JSON.stringify(logPayload),
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(statusCode).json(body);
  }

  private buildBody(
    exception: unknown,
    statusCode: number,
    path: string,
  ): ErrorBody {
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const response = exception.getResponse();
      const message =
        httpStatus === HttpStatus.NOT_FOUND
          ? 'A rota solicitada nao foi encontrada. Volte e tente novamente pelo menu principal.'
          : this.extractMessage(response);
      return {
        statusCode,
        error:
          statusCode === HttpStatus.NOT_FOUND
            ? 'RouteNotFound'
            : statusCode === HttpStatus.BAD_REQUEST
              ? 'RequestError'
              : statusCode === HttpStatus.SERVICE_UNAVAILABLE
                ? 'ServiceUnavailable'
                : statusCode === HttpStatus.TOO_MANY_REQUESTS
                  ? 'RateLimited'
              : 'ApplicationError',
        message,
        timestamp,
        path,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return {
        statusCode,
        error: 'DatabaseRequestError',
        message: this.mapPrismaKnownError(exception),
        timestamp,
        path,
      };
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode,
        error: 'DatabaseValidationError',
        message: 'Os dados enviados nao puderam ser processados. Revise e tente novamente.',
        timestamp,
        path,
      };
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        statusCode,
        error: 'DependencyUnavailable',
        message:
          'Nao conseguimos concluir essa acao agora porque um servico essencial nao respondeu.',
        timestamp,
        path,
      };
    }

    if (axios.isAxiosError(exception)) {
      return {
        statusCode,
        error: 'DependencyUnavailable',
        message:
          'Nao conseguimos concluir essa acao porque um provedor externo nao respondeu como esperado.',
        timestamp,
        path,
      };
    }

    return {
      statusCode,
      error:
        statusCode === HttpStatus.FAILED_DEPENDENCY
          ? 'DependencyUnavailable'
          : 'RequestGuarded',
      message:
        'Algo saiu do fluxo esperado, mas o app continua de pe. Tente novamente em instantes.',
      timestamp,
      path,
    };
  }

  private extractMessage(response: string | object): string {
    if (typeof response === 'string' && response.trim()) {
      return response;
    }

    if (
      response &&
      typeof response === 'object' &&
      'message' in response &&
      response.message
    ) {
      const message = (response as { message?: unknown }).message;
      if (Array.isArray(message)) {
        return message
          .filter((item): item is string => typeof item === 'string')
          .join(' | ');
      }
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }

    return 'Nao foi possivel concluir a solicitacao.';
  }

  private mapPrismaKnownError(error: Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        return 'Ja existe um registro com esses dados.';
      case 'P2003':
        return 'Existe uma referencia invalida entre os dados enviados.';
      case 'P2025':
        return 'O registro solicitado nao foi encontrado.';
      case 'P2021':
      case 'P2022':
        return 'O banco publicado esta com estrutura desatualizada para esta operacao. Sincronize as migrations e tente novamente.';
      default:
        return 'O banco recusou a operacao. Ajuste os dados e tente novamente.';
    }
  }
}
