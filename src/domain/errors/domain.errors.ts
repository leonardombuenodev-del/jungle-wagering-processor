export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
  constructor(walletId: string, balance: string, requested: string) {
    super(`Insufficient funds on wallet ${walletId}: balance is ${balance}, requested ${requested}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
  constructor(transactionId: string, currentStatus: string, attemptedTransition: string) {
    super(
      `Cannot transition transaction ${transactionId} from terminal/current state ${currentStatus} to ${attemptedTransition}`,
    );
  }
}

export class InvalidDomainOperationError extends DomainError {
  readonly code = "INVALID_DOMAIN_OPERATION";
  constructor(message: string) {
    super(message);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor(idempotencyKey: string) {
    super(`Idempotency key '${idempotencyKey}' was already used with a different payload`);
  }
}

export class DuplicateWalletError extends DomainError {
  readonly code = "DUPLICATE_WALLET";
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player '${playerId}' and currency '${currency}'`);
  }
}
