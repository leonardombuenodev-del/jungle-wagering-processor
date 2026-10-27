import { EntitySchema } from "@mikro-orm/core";

export class WalletOrmEntity {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletOrmEntity>({
  class: WalletOrmEntity,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    currency: { type: "string", length: 3 },
    balanceAmount: {
      type: "numeric",
      fieldName: "balance_amount",
      precision: 18,
      scale: 2,
    },
    version: { type: "integer", default: 1 },
    createdAt: { type: "Date", fieldName: "created_at", onCreate: () => new Date() },
    updatedAt: { type: "Date", fieldName: "updated_at", onCreate: () => new Date(), onUpdate: () => new Date() },
  },
});
