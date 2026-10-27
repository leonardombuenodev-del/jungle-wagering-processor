import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { WalletSchema } from "./entities/wallet.orm-entity";
import { WagerTransactionSchema } from "./entities/wager-transaction.orm-entity";
import { WalletLedgerEntrySchema } from "./entities/wallet-ledger-entry.orm-entity";
import { InboxMessageSchema } from "./entities/inbox-message.orm-entity";
import { OutboxMessageSchema } from "./entities/outbox-message.orm-entity";
import { Migration202607290001_InitialSchema } from "./migrations/Migration202607290001_InitialSchema";

export function buildMikroOrmConfig() {
  return defineConfig({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? "jungle",
    password: process.env.DB_PASSWORD ?? "jungle_secret",
    dbName: process.env.DB_NAME ?? "jungle_wagering",
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        {
          name: "Migration202607290001_InitialSchema",
          class: Migration202607290001_InitialSchema,
        },
      ],
    },
    pool: {
      min: 2,
      max: Number(process.env.DB_POOL_MAX ?? 25),
    },
    debug: false,
  });
}

export default buildMikroOrmConfig();
