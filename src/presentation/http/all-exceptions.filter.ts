import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import {
  DomainError,
  IdempotencyConflictError,
  InsufficientFundsError,
  NegativeBalanceOnReversalError,
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../domain/errors/domain-errors';
import { TransientDatabaseError, UniqueConstraintViolationError, type LoggerPort } from '../../application/ports';

interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

function statusFor(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  if (
    error instanceof ValidationError ||
    error instanceof WalletCurrencyMismatchError ||
    error instanceof WalletPlayerMismatchError
  ) {
    return 400;
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) return 404;
  if (
    error instanceof WalletAlreadyExistsError ||
    error instanceof IdempotencyConflictError ||
    error instanceof UniqueConstraintViolationError
  ) {
    return 409;
  }
  if (error instanceof InsufficientFundsError || error instanceof NegativeBalanceOnReversalError) {
    return 422;
  }
  // falha transitória de infra: o provedor pode reenviar com a mesma Idempotency-Key
  if (error instanceof TransientDatabaseError) return 503;
  return 500;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerPort) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status = statusFor(error);

    if (status >= 500) {
      // detalhe só no log; o corpo não expõe stack nem mensagem interna
      this.logger.error('Erro não tratado na requisição HTTP', {
        error: (error as Error)?.message,
        reason: (error as Error)?.name,
      });
      response.status(status).json({
        error: status === 503 ? 'ServiceUnavailable' : 'InternalServerError',
        message: status === 503 ? 'Falha transitória, tente novamente' : 'Erro interno do servidor',
      });
      return;
    }

    response.status(status).json({
      error: (error as Error)?.name ?? 'Error',
      message: (error as Error)?.message ?? 'Erro',
      ...(error instanceof DomainError && error.failureCode ? { failureCode: error.failureCode } : {}),
    });
  }
}

