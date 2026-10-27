import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { SubmitWagerTransactionUseCase } from "../../../application/use-cases/submit-wager-transaction.use-case";
import { WageringQueriesUseCase } from "../../../application/use-cases/wagering-queries.use-case";
import { MoneyProps } from "../../../domain/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction";
import { ProviderAuthGuard } from "../guards/provider-auth.guard";

interface SubmitWagerBodyDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const VALID_EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitWagerUseCase: SubmitWagerTransactionUseCase,
    @Inject(WageringQueriesUseCase)
    private readonly queriesUseCase: WageringQueriesUseCase,
  ) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationIdHeader: string | undefined,
    @Body() body: SubmitWagerBodyDto,
    @Req() req: Request,
  ) {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException("Idempotency-Key header is required");
    }

    this.validateSubmitBody(body);

    const correlationId = correlationIdHeader ?? crypto.randomUUID();
    const output = await this.submitWagerUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId,
    });

    this.logger.log({
      msg: "HTTP wager transaction processed",
      correlationId,
      transactionId: output.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      kind: body.kind,
      status: output.status,
      failureCode: output.failureCode,
      idempotentReplay: output.idempotentReplay,
    });

    let httpStatus = HttpStatus.OK;
    if (output.status === WagerTransactionStatus.PendingReference) {
      httpStatus = HttpStatus.ACCEPTED;
    } else if (output.status === WagerTransactionStatus.Rejected) {
      httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
    }

    req.res?.status(httpStatus);

    return {
      transactionId: output.transactionId,
      status: output.status,
      ...(output.balance ? { balance: output.balance } : {}),
      ...(output.failureCode ? { failureCode: output.failureCode } : {}),
      idempotentReplay: output.idempotentReplay,
    };
  }

  @Get("wagering/transactions/:transactionId")
  async getTransactionById(@Param("transactionId") transactionId: string) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(transactionId)) {
      throw new BadRequestException("transactionId must be a valid UUID");
    }
    return await this.queriesUseCase.getTransactionById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByProviderExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return await this.queriesUseCase.getTransactionByProviderExternalId(
      providerId,
      externalTransactionId,
    );
  }

  private validateSubmitBody(body: SubmitWagerBodyDto): void {
    if (!body || typeof body !== "object") {
      throw new BadRequestException("Request body is required");
    }

    const requiredStrings: Array<keyof SubmitWagerBodyDto> = [
      "providerId",
      "externalTransactionId",
      "playerId",
      "walletId",
      "roundId",
      "gameId",
      "kind",
    ];

    for (const field of requiredStrings) {
      const val = body[field];
      if (typeof val !== "string" || !val.trim()) {
        throw new BadRequestException(`${String(field)} is required and must be a non-empty string`);
      }
    }

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(body.walletId)) {
      throw new BadRequestException("walletId must be a valid UUID");
    }

    if (!VALID_EXTERNAL_KINDS.has(body.kind)) {
      throw new BadRequestException(
        `Invalid transaction kind '${body.kind}'. Allowed values: BET, WIN, LOSS, REFUND, ROLLBACK`,
      );
    }

    if (!body.money || typeof body.money !== "object") {
      throw new BadRequestException("money object is required");
    }
  }
}
