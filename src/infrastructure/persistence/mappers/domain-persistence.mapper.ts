import { FailureCode } from "../../../domain/failure-code";
import { InboxMessage } from "../../../domain/inbox-message";
import { Money } from "../../../domain/money";
import { OutboxMessage } from "../../../domain/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wager-transaction";
import { Wallet } from "../../../domain/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../domain/wallet-ledger-entry";
import { InboxMessageOrmEntity } from "../entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "../entities/outbox-message.orm-entity";
import { WagerTransactionOrmEntity } from "../entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "../entities/wallet-ledger-entry.orm-entity";
import { WalletOrmEntity } from "../entities/wallet.orm-entity";

function formatNumeric2(val: string | number): string {
  return Number(val).toFixed(2);
}

export class DomainPersistenceMapper {
  static toWalletDomain(orm: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: orm.id,
      playerId: orm.playerId,
      currency: orm.currency,
      balance: Money.rehydrate({
        amount: formatNumeric2(orm.balanceAmount),
        currency: orm.currency,
      }),
      version: Number(orm.version),
      createdAt: new Date(orm.createdAt),
      updatedAt: new Date(orm.updatedAt),
    });
  }

  static toWalletOrm(domain: Wallet): WalletOrmEntity {
    const orm = new WalletOrmEntity();
    orm.id = domain.id;
    orm.playerId = domain.playerId;
    orm.currency = domain.currency;
    orm.balanceAmount = domain.balance.toString();
    orm.version = domain.version;
    orm.createdAt = domain.createdAt;
    orm.updatedAt = domain.updatedAt;
    return orm;
  }

  static toTransactionDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      idempotencyKey: orm.idempotencyKey,
      payloadHash: orm.payloadHash,
      walletId: orm.walletId,
      playerId: orm.playerId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind as WagerTransactionKind,
      money: Money.rehydrate({
        amount: formatNumeric2(orm.amount),
        currency: orm.currency,
      }),
      referenceExternalTransactionId: orm.referenceExternalTransactionId ?? undefined,
      createdAt: new Date(orm.createdAt),
      status: orm.status as WagerTransactionStatus,
      referenceTransactionId: orm.referenceTransactionId ?? undefined,
      failureCode: (orm.failureCode as FailureCode) ?? undefined,
      processedAt: orm.processedAt ? new Date(orm.processedAt) : undefined,
      observedBalanceAfter:
        orm.observedBalanceAfter !== null && orm.observedBalanceAfter !== undefined
          ? Money.rehydrate({
              amount: formatNumeric2(orm.observedBalanceAfter),
              currency: orm.currency,
            })
          : undefined,
      retryAttempts: Number(orm.retryAttempts ?? 0),
      nextRetryAt: orm.nextRetryAt ? new Date(orm.nextRetryAt) : undefined,
    });
  }

  static toTransactionOrm(domain: WagerTransaction): WagerTransactionOrmEntity {
    const orm = new WagerTransactionOrmEntity();
    orm.id = domain.id;
    orm.providerId = domain.providerId;
    orm.externalTransactionId = domain.externalTransactionId;
    orm.idempotencyKey = domain.idempotencyKey;
    orm.payloadHash = domain.payloadHash;
    orm.walletId = domain.walletId;
    orm.playerId = domain.playerId;
    orm.roundId = domain.roundId;
    orm.gameId = domain.gameId;
    orm.kind = domain.kind;
    orm.amount = domain.money.toString();
    orm.currency = domain.money.currency;
    orm.referenceExternalTransactionId = domain.referenceExternalTransactionId ?? null;
    orm.referenceTransactionId = domain.referenceTransactionId ?? null;
    orm.status = domain.status;
    orm.failureCode = domain.failureCode ?? null;
    orm.observedBalanceAfter = domain.observedBalanceAfter
      ? domain.observedBalanceAfter.toString()
      : null;
    orm.retryAttempts = domain.retryAttempts;
    orm.nextRetryAt = domain.nextRetryAt ?? null;
    orm.createdAt = domain.createdAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }

  static toLedgerDomain(orm: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: orm.id,
      walletId: orm.walletId,
      transactionId: orm.transactionId,
      direction: orm.direction as LedgerDirection,
      money: Money.rehydrate({
        amount: formatNumeric2(orm.amount),
        currency: orm.currency,
      }),
      balanceBefore: Money.rehydrate({
        amount: formatNumeric2(orm.balanceBefore),
        currency: orm.currency,
      }),
      balanceAfter: Money.rehydrate({
        amount: formatNumeric2(orm.balanceAfter),
        currency: orm.currency,
      }),
      createdAt: new Date(orm.createdAt),
    });
  }

  static toLedgerOrm(domain: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const orm = new WalletLedgerEntryOrmEntity();
    orm.id = domain.id;
    orm.walletId = domain.walletId;
    orm.transactionId = domain.transactionId;
    orm.direction = domain.direction;
    orm.amount = domain.money.toString();
    orm.currency = domain.money.currency;
    orm.balanceBefore = domain.balanceBefore.toString();
    orm.balanceAfter = domain.balanceAfter.toString();
    orm.createdAt = domain.createdAt;
    return orm;
  }

  static toInboxDomain(orm: InboxMessageOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: orm.consumerName,
      messageId: orm.messageId,
      payloadHash: orm.payloadHash,
      receivedAt: new Date(orm.receivedAt),
      processedAt: orm.processedAt ? new Date(orm.processedAt) : undefined,
    });
  }

  static toInboxOrm(domain: InboxMessage): InboxMessageOrmEntity {
    const orm = new InboxMessageOrmEntity();
    orm.consumerName = domain.consumerName;
    orm.messageId = domain.messageId;
    orm.payloadHash = domain.payloadHash;
    orm.receivedAt = domain.receivedAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }

  static toOutboxDomain(orm: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: orm.id,
      aggregateId: orm.aggregateId,
      eventType: orm.eventType,
      payload: orm.payload,
      occurredAt: new Date(orm.occurredAt),
      attempts: Number(orm.attempts),
      nextAttemptAt: orm.nextAttemptAt ? new Date(orm.nextAttemptAt) : undefined,
      publishedAt: orm.publishedAt ? new Date(orm.publishedAt) : undefined,
    });
  }

  static toOutboxOrm(domain: OutboxMessage): OutboxMessageOrmEntity {
    const orm = new OutboxMessageOrmEntity();
    orm.id = domain.id;
    orm.aggregateId = domain.aggregateId;
    orm.eventType = domain.eventType;
    orm.payload = { ...domain.payload };
    orm.occurredAt = domain.occurredAt;
    orm.attempts = domain.attempts;
    orm.nextAttemptAt = domain.nextAttemptAt ?? null;
    orm.publishedAt = domain.publishedAt ?? null;
    return orm;
  }
}
