import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { computeCanonicalPayloadHash } from "../../domain/canonical-hash";
import {
  IdempotencyConflictError,
  InvalidDomainOperationError,
} from "../../domain/errors/domain.errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/integration-event";
import { FailureCode } from "../../domain/failure-code";
import { InboxMessage } from "../../domain/inbox-message";
import { Money, MoneyProps } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { WagerTransactionOrmEntity } from "../../infrastructure/persistence/entities/wager-transaction.orm-entity";
import { WalletOrmEntity } from "../../infrastructure/persistence/entities/wallet.orm-entity";
import { DomainPersistenceMapper } from "../../infrastructure/persistence/mappers/domain-persistence.mapper";

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: {
    consumerName: string;
    messageId: string;
  };
}

export interface SubmitWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

type KnexTrx = ReturnType<EntityManager["getKnex"]>;

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionOutput> {
    const startMs = performance.now();

    if (cmd.kind === WagerTransactionKind.Opening) {
      throw new InvalidDomainOperationError("OPENING transaction kind is strictly internal");
    }

    const money = Money.from(cmd.money);
    const payloadHash = computeCanonicalPayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });

    const correlationId = cmd.correlationId ?? crypto.randomUUID();

    try {
      return await this.em.getKnex().transaction(async (knex) => {
        const now = new Date();

        await knex("wallets").where({ id: cmd.walletId }).forUpdate().first();

        if (cmd.inboxContext) {
          const inboxRow = await knex("inbox_messages")
            .where({
              consumer_name: cmd.inboxContext.consumerName,
              message_id: cmd.inboxContext.messageId,
            })
            .forUpdate()
            .first();

          if (inboxRow && inboxRow.processed_at) {
            this.metrics.duplicatesDetectedTotal.inc({ source: "sqs_inbox" });
            const existingByKey = await this.findExistingTransaction(
              knex,
              cmd.idempotencyKey,
              cmd.providerId,
              cmd.externalTransactionId,
            );
            if (existingByKey) {
              return this.buildReplayResponse(existingByKey);
            }
          }

          const inboxMsg = InboxMessage.receive({
            consumerName: cmd.inboxContext.consumerName,
            messageId: cmd.inboxContext.messageId,
            payloadHash,
            receivedAt: now,
          });
          inboxMsg.markProcessed(now);

          await knex("inbox_messages")
            .insert({
              consumer_name: inboxMsg.consumerName,
              message_id: inboxMsg.messageId,
              payload_hash: inboxMsg.payloadHash,
              received_at: inboxMsg.receivedAt,
              processed_at: inboxMsg.processedAt,
            })
            .onConflict(["consumer_name", "message_id"])
            .merge({ processed_at: now });
        }

        const preExisting = await this.findExistingTransaction(
          knex,
          cmd.idempotencyKey,
          cmd.providerId,
          cmd.externalTransactionId,
        );
        if (preExisting) {
          if (!preExisting.matchesPayload(payloadHash)) {
            throw new IdempotencyConflictError(cmd.idempotencyKey);
          }
          this.metrics.duplicatesDetectedTotal.inc({ source: "idempotency_key" });
          return this.buildReplayResponse(preExisting);
        }

        const txDomain = WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind,
          money,
          referenceExternalTransactionId: cmd.referenceExternalTransactionId,
          createdAt: now,
        });

        await knex.raw("SAVEPOINT sp_insert_wager_tx");
        try {
          await this.insertTransactionRow(knex, txDomain);
          await knex.raw("RELEASE SAVEPOINT sp_insert_wager_tx");
        } catch (err: unknown) {
          await knex.raw("ROLLBACK TO SAVEPOINT sp_insert_wager_tx");
          const pgCode = (err as { code?: string })?.code;
          if (pgCode === "23505") {
            this.metrics.lockConflictsTotal.inc({ operation: "idempotency_insert" });
            const concurrentTx = await this.findExistingTransaction(
              knex,
              cmd.idempotencyKey,
              cmd.providerId,
              cmd.externalTransactionId,
            );
            if (concurrentTx) {
              if (!concurrentTx.matchesPayload(payloadHash)) {
                throw new IdempotencyConflictError(cmd.idempotencyKey);
              }
              this.metrics.duplicatesDetectedTotal.inc({ source: "idempotency_race" });
              return this.buildReplayResponse(concurrentTx);
            }
          }
          throw err;
        }

        return await this.processTransactionInsideTx(knex, txDomain, correlationId, now);
      });
    } finally {
      this.metrics.processingLatencyMs.observe(
        { operation: cmd.kind },
        performance.now() - startMs,
      );
    }
  }

  async processTransactionInsideTx(
    knex: KnexTrx,
    txDomain: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerTransactionOutput> {
    const walletRow = await knex("wallets")
      .where({ id: txDomain.walletId })
      .forUpdate()
      .first();

    if (!walletRow) {
      return await this.rejectTransaction(
        knex,
        txDomain,
        FailureCode.WalletNotFound,
        undefined,
        correlationId,
        now,
      );
    }

    const wallet = DomainPersistenceMapper.toWalletDomain(this.mapRawWallet(walletRow));

    if (wallet.playerId !== txDomain.playerId) {
      return await this.rejectTransaction(
        knex,
        txDomain,
        FailureCode.ReferenceContextMismatch,
        wallet.balance,
        correlationId,
        now,
      );
    }

    if (wallet.currency !== txDomain.money.currency) {
      return await this.rejectTransaction(
        knex,
        txDomain,
        FailureCode.CurrencyMismatch,
        wallet.balance,
        correlationId,
        now,
      );
    }

    let referenceTx: WagerTransaction | undefined;

    if (txDomain.referenceExternalTransactionId) {
      const refRow = await knex("wager_transactions")
        .where({
          provider_id: txDomain.providerId,
          external_transaction_id: txDomain.referenceExternalTransactionId,
        })
        .first();

      if (!refRow) {
        if (txDomain.requiresReference()) {
          const nextRetryAt = new Date(now.getTime() + 500);
          txDomain.markPendingReference(nextRetryAt);
          await knex("wager_transactions")
            .where({ id: txDomain.id })
            .update({
              status: txDomain.status,
              next_retry_at: nextRetryAt,
              observed_balance_after: wallet.balance.toString(),
            });

          const pendingEvent = OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(txDomain, {
              correlationId,
              occurredAt: now,
            }),
          );
          await this.insertOutboxRow(knex, pendingEvent);

          this.metrics.transactionsTotal.inc({
            kind: txDomain.kind,
            status: txDomain.status,
            failure_code: "NONE",
          });

          return {
            transactionId: txDomain.id,
            status: WagerTransactionStatus.PendingReference,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }
      } else {
        referenceTx = DomainPersistenceMapper.toTransactionDomain(this.mapRawTx(refRow));
      }
    }

    if (txDomain.requiresReference() && referenceTx) {
      if (
        referenceTx.providerId !== txDomain.providerId ||
        referenceTx.playerId !== txDomain.playerId ||
        referenceTx.walletId !== txDomain.walletId ||
        referenceTx.money.currency !== txDomain.money.currency ||
        referenceTx.roundId !== txDomain.roundId
      ) {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.ReferenceContextMismatch,
          wallet.balance,
          correlationId,
          now,
        );
      }

      if (referenceTx.status !== WagerTransactionStatus.Processed) {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.InvalidReferenceStatus,
          wallet.balance,
          correlationId,
          now,
        );
      }

      if (
        txDomain.kind === WagerTransactionKind.Refund &&
        referenceTx.kind !== WagerTransactionKind.Bet
      ) {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.InvalidReferenceKind,
          wallet.balance,
          correlationId,
          now,
        );
      }

      if (
        txDomain.kind === WagerTransactionKind.Rollback &&
        referenceTx.kind !== WagerTransactionKind.Bet &&
        referenceTx.kind !== WagerTransactionKind.Win &&
        referenceTx.kind !== WagerTransactionKind.Refund
      ) {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.InvalidReferenceKind,
          wallet.balance,
          correlationId,
          now,
        );
      }

      if (!referenceTx.money.equals(txDomain.money)) {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.ReferenceAmountMismatch,
          wallet.balance,
          correlationId,
          now,
        );
      }

      const existingReversal = await knex("wager_transactions")
        .where({
          reference_transaction_id: referenceTx.id,
          status: WagerTransactionStatus.Processed,
        })
        .whereIn("kind", [WagerTransactionKind.Refund, WagerTransactionKind.Rollback])
        .first();

      if (existingReversal) {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.ReferenceAlreadyReversed,
          wallet.balance,
          correlationId,
          now,
        );
      }
    }

    let ledgerEntry: WalletLedgerEntry | undefined;

    if (txDomain.affectsBalance()) {
      const direction = txDomain.ledgerDirectionFor(referenceTx);

      if (direction === LedgerDirection.Debit) {
        if (wallet.balance.isLessThan(txDomain.money)) {
          const failureCode =
            txDomain.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalWouldCauseNegativeBalance
              : FailureCode.InsufficientFunds;

          return await this.rejectTransaction(
            knex,
            txDomain,
            failureCode,
            wallet.balance,
            correlationId,
            now,
          );
        }

        ledgerEntry = wallet.debit({
          ledgerEntryId: crypto.randomUUID(),
          transactionId: txDomain.id,
          amount: txDomain.money,
          at: now,
        });
      } else {
        ledgerEntry = wallet.credit({
          ledgerEntryId: crypto.randomUUID(),
          transactionId: txDomain.id,
          amount: txDomain.money,
          at: now,
        });
      }
    }

    txDomain.markProcessed(referenceTx?.id, now, wallet.balance);

    await knex.raw("SAVEPOINT sp_apply_financials");
    try {
      await knex("wager_transactions")
        .where({ id: txDomain.id })
        .update({
          status: txDomain.status,
          reference_transaction_id: txDomain.referenceTransactionId ?? null,
          processed_at: now,
          observed_balance_after: wallet.balance.toString(),
        });

      if (ledgerEntry) {
        await knex("wallets")
          .where({ id: wallet.id })
          .update({
            balance_amount: wallet.balance.toString(),
            version: wallet.version,
            updated_at: wallet.updatedAt,
          });

        await knex("wallet_ledger_entries").insert({
          id: ledgerEntry.id,
          wallet_id: ledgerEntry.walletId,
          transaction_id: ledgerEntry.transactionId,
          direction: ledgerEntry.direction,
          amount: ledgerEntry.money.toString(),
          currency: ledgerEntry.money.currency,
          balance_before: ledgerEntry.balanceBefore.toString(),
          balance_after: ledgerEntry.balanceAfter.toString(),
          created_at: ledgerEntry.createdAt,
        });

        const balanceOutbox = OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            correlationId,
            occurredAt: now,
          }),
        );
        await this.insertOutboxRow(knex, balanceOutbox);
      }

      const processedOutbox = OutboxMessage.enqueue(
        WagerTransactionProcessed.from(txDomain, wallet.balance.toJSON(), {
          correlationId,
          occurredAt: now,
        }),
      );
      await this.insertOutboxRow(knex, processedOutbox);

      await knex.raw("RELEASE SAVEPOINT sp_apply_financials");
    } catch (err: unknown) {
      await knex.raw("ROLLBACK TO SAVEPOINT sp_apply_financials");
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") {
        return await this.rejectTransaction(
          knex,
          txDomain,
          FailureCode.ReferenceAlreadyReversed,
          wallet.balance,
          correlationId,
          now,
        );
      }
      throw err;
    }

    this.metrics.transactionsTotal.inc({
      kind: txDomain.kind,
      status: txDomain.status,
      failure_code: "NONE",
    });

    return {
      transactionId: txDomain.id,
      status: txDomain.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async rejectTransaction(
    knex: KnexTrx,
    txDomain: WagerTransaction,
    failureCode: FailureCode,
    observedBalance: Money | undefined,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerTransactionOutput> {
    txDomain.reject(failureCode, now, observedBalance);

    await knex("wager_transactions")
      .where({ id: txDomain.id })
      .update({
        status: txDomain.status,
        failure_code: failureCode,
        processed_at: now,
        observed_balance_after: observedBalance ? observedBalance.toString() : null,
      });

    const rejectedOutbox = OutboxMessage.enqueue(
      WagerTransactionRejected.from(txDomain, failureCode, {
        correlationId,
        occurredAt: now,
      }),
    );
    await this.insertOutboxRow(knex, rejectedOutbox);

    this.metrics.transactionsTotal.inc({
      kind: txDomain.kind,
      status: txDomain.status,
      failure_code: failureCode,
    });

    return {
      transactionId: txDomain.id,
      status: WagerTransactionStatus.Rejected,
      balance: observedBalance?.toJSON(),
      failureCode,
      idempotentReplay: false,
    };
  }

  private buildReplayResponse(existing: WagerTransaction): SubmitWagerTransactionOutput {
    return {
      transactionId: existing.id,
      status: existing.status,
      balance: existing.observedBalanceAfter?.toJSON(),
      failureCode: existing.failureCode,
      idempotentReplay: true,
    };
  }

  private async findExistingTransaction(
    knex: KnexTrx,
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await knex("wager_transactions")
      .where({ idempotency_key: idempotencyKey })
      .orWhere({
        provider_id: providerId,
        external_transaction_id: externalTransactionId,
      })
      .first();

    if (!row) return null;
    return DomainPersistenceMapper.toTransactionDomain(this.mapRawTx(row));
  }

  private async insertTransactionRow(
    knex: KnexTrx,
    txDomain: WagerTransaction,
  ): Promise<void> {
    const orm = DomainPersistenceMapper.toTransactionOrm(txDomain);
    await knex("wager_transactions").insert({
      id: orm.id,
      provider_id: orm.providerId,
      external_transaction_id: orm.externalTransactionId,
      idempotency_key: orm.idempotencyKey,
      payload_hash: orm.payloadHash,
      wallet_id: orm.walletId,
      player_id: orm.playerId,
      round_id: orm.roundId,
      game_id: orm.gameId,
      kind: orm.kind,
      amount: orm.amount,
      currency: orm.currency,
      reference_external_transaction_id: orm.referenceExternalTransactionId,
      reference_transaction_id: orm.referenceTransactionId,
      status: orm.status,
      failure_code: orm.failureCode,
      observed_balance_after: orm.observedBalanceAfter,
      retry_attempts: orm.retryAttempts,
      next_retry_at: orm.nextRetryAt,
      created_at: orm.createdAt,
      processed_at: orm.processedAt,
    });
  }

  private async insertOutboxRow(
    knex: KnexTrx,
    outbox: OutboxMessage,
  ): Promise<void> {
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

  private mapRawWallet(row: Record<string, unknown>): WalletOrmEntity {
    const orm = new WalletOrmEntity();
    orm.id = String(row.id);
    orm.playerId = String(row.player_id);
    orm.currency = String(row.currency);
    orm.balanceAmount = String(row.balance_amount);
    orm.version = Number(row.version);
    orm.createdAt = new Date(String(row.created_at));
    orm.updatedAt = new Date(String(row.updated_at));
    return orm;
  }

  private mapRawTx(row: Record<string, unknown>): WagerTransactionOrmEntity {
    const orm = new WagerTransactionOrmEntity();
    orm.id = String(row.id);
    orm.providerId = String(row.provider_id);
    orm.externalTransactionId = String(row.external_transaction_id);
    orm.idempotencyKey = String(row.idempotency_key);
    orm.payloadHash = String(row.payload_hash);
    orm.walletId = String(row.wallet_id);
    orm.playerId = String(row.player_id);
    orm.roundId = String(row.round_id);
    orm.gameId = String(row.game_id);
    orm.kind = String(row.kind);
    orm.amount = String(row.amount);
    orm.currency = String(row.currency);
    orm.referenceExternalTransactionId = row.reference_external_transaction_id
      ? String(row.reference_external_transaction_id)
      : null;
    orm.referenceTransactionId = row.reference_transaction_id
      ? String(row.reference_transaction_id)
      : null;
    orm.status = String(row.status);
    orm.failureCode = row.failure_code ? String(row.failure_code) : null;
    orm.observedBalanceAfter =
      row.observed_balance_after !== null && row.observed_balance_after !== undefined
        ? String(row.observed_balance_after)
        : null;
    orm.retryAttempts = Number(row.retry_attempts ?? 0);
    orm.nextRetryAt = row.next_retry_at ? new Date(String(row.next_retry_at)) : null;
    orm.createdAt = new Date(String(row.created_at));
    orm.processedAt = row.processed_at ? new Date(String(row.processed_at)) : null;
    return orm;
  }
}
