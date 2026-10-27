import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { DuplicateWalletError } from "../../domain/errors/domain.errors";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../domain/events/integration-event";
import { Money, MoneyProps } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { DomainPersistenceMapper } from "../../infrastructure/persistence/mappers/domain-persistence.mapper";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletOutput> {
    const initialMoney = Money.from(cmd.initialBalance);
    const walletId = crypto.randomUUID();
    const openingTxId = crypto.randomUUID();
    const openingLedgerId = crypto.randomUUID();
    const now = new Date();
    const correlationId = cmd.correlationId ?? crypto.randomUUID();

    const { wallet, openingLedgerEntry } = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance: initialMoney,
      openingTransactionId: openingTxId,
      openingLedgerEntryId: openingLedgerId,
      now,
    });

    try {
      await this.em.getKnex().transaction(async (knex) => {
        await knex("wallets").insert({
          id: wallet.id,
          player_id: wallet.playerId,
          currency: wallet.currency,
          balance_amount: wallet.balance.toString(),
          version: wallet.version,
          created_at: wallet.createdAt,
          updated_at: wallet.updatedAt,
        });

        if (openingLedgerEntry) {
          const openingTx = WagerTransaction.createOpening({
            id: openingTxId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialMoney,
            at: now,
          });

          const txOrm = DomainPersistenceMapper.toTransactionOrm(openingTx);
          await knex("wager_transactions").insert({
            id: txOrm.id,
            provider_id: txOrm.providerId,
            external_transaction_id: txOrm.externalTransactionId,
            idempotency_key: txOrm.idempotencyKey,
            payload_hash: txOrm.payloadHash,
            wallet_id: txOrm.walletId,
            player_id: txOrm.playerId,
            round_id: txOrm.roundId,
            game_id: txOrm.gameId,
            kind: txOrm.kind,
            amount: txOrm.amount,
            currency: txOrm.currency,
            reference_external_transaction_id: null,
            reference_transaction_id: null,
            status: txOrm.status,
            failure_code: null,
            observed_balance_after: txOrm.observedBalanceAfter,
            retry_attempts: 0,
            next_retry_at: null,
            created_at: txOrm.createdAt,
            processed_at: txOrm.processedAt,
          });

          await knex("wallet_ledger_entries").insert({
            id: openingLedgerEntry.id,
            wallet_id: openingLedgerEntry.walletId,
            transaction_id: openingLedgerEntry.transactionId,
            direction: openingLedgerEntry.direction,
            amount: openingLedgerEntry.money.toString(),
            currency: openingLedgerEntry.money.currency,
            balance_before: openingLedgerEntry.balanceBefore.toString(),
            balance_after: openingLedgerEntry.balanceAfter.toString(),
            created_at: openingLedgerEntry.createdAt,
          });

          const balanceEvent = OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingLedgerEntry, {
              correlationId,
              occurredAt: now,
            }),
          );
          const processedEvent = OutboxMessage.enqueue(
            WagerTransactionProcessed.from(openingTx, wallet.balance.toJSON(), {
              correlationId,
              occurredAt: now,
            }),
          );

          for (const outbox of [balanceEvent, processedEvent]) {
            await knex("outbox_messages").insert({
              id: outbox.id,
              aggregate_id: outbox.aggregateId,
              event_type: outbox.eventType,
              payload: outbox.payload,
              occurred_at: outbox.occurredAt,
              attempts: outbox.attempts,
              next_attempt_at: outbox.nextAttemptAt ?? null,
              published_at: null,
            });
          }
        }
      });
    } catch (err: unknown) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") {
        throw new DuplicateWalletError(cmd.playerId, initialMoney.currency);
      }
      throw err;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
