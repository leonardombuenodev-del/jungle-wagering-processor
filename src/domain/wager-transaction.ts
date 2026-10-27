import {
  InvalidDomainOperationError,
  InvalidTransactionStateError,
} from "./errors/domain.errors";
import { FailureCode } from "./failure-code";
import { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalanceAfter?: Money;
  retryAttempts?: number;
  nextRetryAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalanceAfter?: Money,
    private _retryAttempts: number = 0,
    private _nextRetryAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new InvalidDomainOperationError(
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidDomainOperationError(
        `${props.kind} transaction amount must be strictly positive`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
  }): WagerTransaction {
    return new WagerTransaction(
      props.id,
      "INTERNAL",
      `opening:${props.walletId}`,
      `internal:opening:${props.walletId}`,
      "OPENING_HASH",
      props.walletId,
      props.playerId,
      "opening-round",
      "wallet-opening",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.at,
      props.money,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalanceAfter,
      state.retryAttempts ?? 0,
      state.nextRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalanceAfter(): Money | undefined {
    return this._observedBalanceAfter;
  }

  get retryAttempts(): number {
    return this._retryAttempts;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalanceAfter?: Money,
  ): void {
    this.assertNotTerminal("PROCESSED");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    if (observedBalanceAfter) {
      this._observedBalanceAfter = observedBalanceAfter;
    }
  }

  markPendingReference(nextRetryAt?: Date): void {
    this.assertNotTerminal("PENDING_REFERENCE");
    this._status = WagerTransactionStatus.PendingReference;
    if (nextRetryAt) {
      this._nextRetryAt = nextRetryAt;
    }
  }

  schedulePendingReferenceRetry(now: Date, baseDelayMs: number = 1000): void {
    this.assertNotTerminal("PENDING_REFERENCE");
    this._retryAttempts += 1;
    const backoffMs = baseDelayMs * Math.pow(2, this._retryAttempts - 1);
    this._nextRetryAt = new Date(now.getTime() + backoffMs);
  }

  reject(code: FailureCode, at: Date = new Date(), observedBalanceAfter?: Money): void {
    this.assertNotTerminal("REJECTED");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    if (observedBalanceAfter) {
      this._observedBalanceAfter = observedBalanceAfter;
    }
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal("FAILED");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && !this.money.isZero();
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Refund:
        if (!reference || reference.kind !== WagerTransactionKind.Bet) {
          throw new InvalidDomainOperationError("REFUND requires a BET reference transaction");
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidDomainOperationError("ROLLBACK requires a reference transaction");
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }
        throw new InvalidDomainOperationError(
          `ROLLBACK cannot reverse a transaction of kind ${reference.kind}`,
        );
      case WagerTransactionKind.Loss:
        throw new InvalidDomainOperationError("LOSS transaction does not produce a ledger entry");
    }
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attemptedTransition);
    }
  }
}
