import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { EntityNotFoundError } from "../../../application/errors/application.errors";
import {
  CurrencyMismatchError,
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidDomainOperationError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from "../../../domain/errors/domain.errors";

@Catch()
export class GlobalDomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalDomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ?? crypto.randomUUID();

    if (exception instanceof InvalidMoneyError || exception instanceof InvalidDomainOperationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof CurrencyMismatchError) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof DuplicateWalletError ||
      exception instanceof InvalidTransactionStateError
    ) {
      response.status(HttpStatus.CONFLICT).json({
        error: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof EntityNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: exception.code,
        message: exception.message,
        correlationId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resBody = exception.getResponse();
      response.status(status).json(
        typeof resBody === "object" && resBody !== null
          ? { ...resBody, correlationId }
          : { error: "HTTP_ERROR", message: String(resBody), correlationId },
      );
      return;
    }

    const pgCode = (exception as { code?: string })?.code;
    const isTransientDbError =
      pgCode === "40001" ||
      pgCode === "40P01" ||
      pgCode === "55P03" ||
      pgCode === "57P01" ||
      pgCode === "08006" ||
      pgCode === "08001" ||
      pgCode === "ECONNREFUSED";

    const status = isTransientDbError
      ? HttpStatus.SERVICE_UNAVAILABLE
      : HttpStatus.INTERNAL_SERVER_ERROR;

    this.logger.error({
      msg: "Unhandled exception in HTTP layer",
      correlationId,
      path: request.url,
      method: request.method,
      status,
      errorCode: pgCode ?? "INTERNAL_ERROR",
      errorMessage: exception instanceof Error ? exception.message : String(exception),
    });

    response.status(status).json({
      error: isTransientDbError
        ? "TRANSIENT_INFRASTRUCTURE_ERROR"
        : "INTERNAL_SERVER_ERROR",
      message: isTransientDbError
        ? "Temporary infrastructure unavailability; safe to retry with same Idempotency-Key"
        : "Unexpected internal error",
      correlationId,
    });
  }
}
