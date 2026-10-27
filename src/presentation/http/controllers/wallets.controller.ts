import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CreateWalletUseCase } from "../../../application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../../application/use-cases/reconcile-wallet.use-case";
import { WageringQueriesUseCase } from "../../../application/use-cases/wagering-queries.use-case";
import { MoneyProps } from "../../../domain/money";
import { ProviderAuthGuard } from "../guards/provider-auth.guard";

interface CreateWalletBodyDto {
  playerId: string;
  initialBalance: MoneyProps;
}

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWalletUseCase: CreateWalletUseCase,
    @Inject(ReconcileWalletUseCase)
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    @Inject(WageringQueriesUseCase)
    private readonly queriesUseCase: WageringQueriesUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body() body: CreateWalletBodyDto,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    if (!body || typeof body.playerId !== "string" || !body.playerId.trim()) {
      throw new BadRequestException("playerId is required");
    }
    if (!body.initialBalance || typeof body.initialBalance !== "object") {
      throw new BadRequestException("initialBalance is required");
    }

    return await this.createWalletUseCase.execute({
      playerId: body.playerId.trim(),
      initialBalance: body.initialBalance,
      correlationId,
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    this.assertUuid(walletId, "walletId");
    return await this.queriesUseCase.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  async getWalletLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    this.assertUuid(walletId, "walletId");
    const parsedLimit = limit ? Number(limit) : 50;
    return await this.queriesUseCase.getWalletLedger(walletId, cursor, parsedLimit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(@Param("walletId") walletId: string) {
    this.assertUuid(walletId, "walletId");
    return await this.reconcileWalletUseCase.execute(walletId);
  }

  private assertUuid(value: string, fieldName: string): void {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(value)) {
      throw new BadRequestException(`${fieldName} must be a valid UUID`);
    }
  }
}
