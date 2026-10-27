export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldCauseNegativeBalance = "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
  MissingReferenceTransaction = "MISSING_REFERENCE_TRANSACTION",
  ReferenceTransactionExpired = "REFERENCE_TRANSACTION_EXPIRED",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  InvalidReferenceStatus = "INVALID_REFERENCE_STATUS",
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  PermanentProcessingFailure = "PERMANENT_PROCESSING_FAILURE",
}
