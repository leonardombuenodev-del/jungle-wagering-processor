import { EntitySchema } from "@mikro-orm/core";

export class WagerTransactionOrmEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalanceAfter?: string | null;
  retryAttempts!: number;
  nextRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionOrmEntity>({
  class: WagerTransactionOrmEntity,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id", length: 128 },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id", length: 128 },
    idempotencyKey: { type: "string", fieldName: "idempotency_key", length: 255 },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    roundId: { type: "string", fieldName: "round_id", length: 128 },
    gameId: { type: "string", fieldName: "game_id", length: 128 },
    kind: { type: "string", length: 32 },
    amount: { type: "numeric", precision: 18, scale: 2 },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      length: 128,
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    status: { type: "string", length: 32 },
    failureCode: { type: "string", fieldName: "failure_code", length: 64, nullable: true },
    observedBalanceAfter: {
      type: "numeric",
      fieldName: "observed_balance_after",
      precision: 18,
      scale: 2,
      nullable: true,
    },
    retryAttempts: { type: "integer", fieldName: "retry_attempts", default: 0 },
    nextRetryAt: { type: "Date", fieldName: "next_retry_at", nullable: true },
    createdAt: { type: "Date", fieldName: "created_at", onCreate: () => new Date() },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});
