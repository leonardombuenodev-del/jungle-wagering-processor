import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Money, MoneyProps } from "../../domain/money";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { EntityNotFoundError } from "../errors/application.errors";

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletOutput> {
    return await this.em.getKnex().transaction(async (knex) => {
      const walletRow = await knex("wallets").where({ id: walletId }).first();
      if (!walletRow) {
        throw new EntityNotFoundError("Wallet", walletId);
      }

      const currency = String(walletRow.currency);
      const storedBalance = Money.rehydrate({
        amount: Number(walletRow.balance_amount).toFixed(2),
        currency,
      });

      const entries = await knex("wallet_ledger_entries")
        .where({ wallet_id: walletId })
        .orderBy("sequence_number", "asc");

      let calculatedBalance = Money.zero(currency);

      for (const row of entries) {
        const entryAmount = Money.rehydrate({
          amount: Number(row.amount).toFixed(2),
          currency: String(row.currency),
        });

        if (row.direction === LedgerDirection.Credit) {
          calculatedBalance = calculatedBalance.add(entryAmount);
        } else {
          calculatedBalance = calculatedBalance.subtract(entryAmount);
        }
      }

      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = difference.isZero();

      if (!consistent) {
        this.metrics.reconciliationDivergencesTotal.inc();
        this.logger.error({
          msg: "Wallet reconciliation divergence detected",
          walletId,
          storedBalance: storedBalance.toString(),
          calculatedBalance: calculatedBalance.toString(),
          difference: difference.toString(),
          checkedEntries: entries.length,
        });
      }

      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });
  }
}
