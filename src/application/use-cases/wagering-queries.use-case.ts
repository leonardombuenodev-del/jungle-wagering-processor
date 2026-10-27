import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { InvalidDomainOperationError } from "../../domain/errors/domain.errors";
import { MoneyProps } from "../../domain/money";
import { EntityNotFoundError } from "../errors/application.errors";

export interface LedgerPageOutput {
  items: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

@Injectable()
export class WageringQueriesUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async getWallet(walletId: string) {
    const knex = this.em.getKnex();
    const row = await knex("wallets").where({ id: walletId }).first();
    if (!row) {
      throw new EntityNotFoundError("Wallet", walletId);
    }

    return {
      id: String(row.id),
      playerId: String(row.player_id),
      balance: {
        amount: Number(row.balance_amount).toFixed(2),
        currency: String(row.currency),
      },
      version: Number(row.version),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  async getWalletLedger(
    walletId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<LedgerPageOutput> {
    const knex = this.em.getKnex();

    const walletExists = await knex("wallets").where({ id: walletId }).first();
    if (!walletExists) {
      throw new EntityNotFoundError("Wallet", walletId);
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    let cursorSeq: string | undefined;

    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!decoded || typeof decoded.seq !== "string") {
          throw new Error("Invalid cursor format");
        }
        cursorSeq = decoded.seq;
      } catch {
        throw new InvalidDomainOperationError("Invalid pagination cursor");
      }
    }

    let query = knex("wallet_ledger_entries")
      .where({ wallet_id: walletId })
      .orderBy("sequence_number", "desc")
      .limit(safeLimit + 1);

    if (cursorSeq) {
      query = query.andWhere("sequence_number", "<", cursorSeq);
    }

    const rows = await query;
    const hasNext = rows.length > safeLimit;
    const pageRows = hasNext ? rows.slice(0, safeLimit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNext && lastRow
        ? Buffer.from(JSON.stringify({ seq: String(lastRow.sequence_number) }), "utf8").toString(
            "base64url",
          )
        : null;

    return {
      items: pageRows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        transactionId: String(r.transaction_id),
        direction: String(r.direction),
        money: {
          amount: Number(r.amount).toFixed(2),
          currency: String(r.currency),
        },
        balanceBefore: {
          amount: Number(r.balance_before).toFixed(2),
          currency: String(r.currency),
        },
        balanceAfter: {
          amount: Number(r.balance_after).toFixed(2),
          currency: String(r.currency),
        },
        createdAt: new Date(String(r.created_at)).toISOString(),
      })),
      nextCursor,
    };
  }

  async getTransactionById(transactionId: string) {
    const knex = this.em.getKnex();
    const row = await knex("wager_transactions").where({ id: transactionId }).first();
    if (!row) {
      throw new EntityNotFoundError("WagerTransaction", transactionId);
    }
    return this.formatTransaction(row);
  }

  async getTransactionByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ) {
    const knex = this.em.getKnex();
    const row = await knex("wager_transactions")
      .where({
        provider_id: providerId,
        external_transaction_id: externalTransactionId,
      })
      .first();

    if (!row) {
      throw new EntityNotFoundError(
        "WagerTransaction",
        `${providerId}:${externalTransactionId}`,
      );
    }
    return this.formatTransaction(row);
  }

  private formatTransaction(row: Record<string, unknown>) {
    const currency = String(row.currency);
    return {
      transactionId: String(row.id),
      providerId: String(row.provider_id),
      externalTransactionId: String(row.external_transaction_id),
      idempotencyKey: String(row.idempotency_key),
      walletId: String(row.wallet_id),
      playerId: String(row.player_id),
      roundId: String(row.round_id),
      gameId: String(row.game_id),
      kind: String(row.kind),
      status: String(row.status),
      money: {
        amount: Number(row.amount).toFixed(2),
        currency,
      },
      ...(row.observed_balance_after !== null && row.observed_balance_after !== undefined
        ? {
            balance: {
              amount: Number(row.observed_balance_after).toFixed(2),
              currency,
            },
          }
        : {}),
      ...(row.reference_external_transaction_id
        ? { referenceExternalTransactionId: String(row.reference_external_transaction_id) }
        : {}),
      ...(row.reference_transaction_id
        ? { referenceTransactionId: String(row.reference_transaction_id) }
        : {}),
      ...(row.failure_code ? { failureCode: String(row.failure_code) } : {}),
      createdAt: new Date(String(row.created_at)).toISOString(),
      ...(row.processed_at
        ? { processedAt: new Date(String(row.processed_at)).toISOString() }
        : {}),
    };
  }
}
