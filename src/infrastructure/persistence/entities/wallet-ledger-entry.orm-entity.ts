import { EntitySchema } from "@mikro-orm/core";

export class WalletLedgerEntryOrmEntity {
  id!: string;
  sequenceNumber?: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryOrmEntity>({
  class: WalletLedgerEntryOrmEntity,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    sequenceNumber: {
      type: "bigint",
      fieldName: "sequence_number",
      autoincrement: true,
      persist: false,
    },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string", length: 16 },
    amount: { type: "numeric", precision: 18, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "numeric", fieldName: "balance_before", precision: 18, scale: 2 },
    balanceAfter: { type: "numeric", fieldName: "balance_after", precision: 18, scale: 2 },
    createdAt: { type: "Date", fieldName: "created_at", onCreate: () => new Date() },
  },
});
