import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import {
  NoOpProviderIdentityAdapter,
  ProviderIdentityPort,
} from "./application/ports/auth.port";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { SubmitWagerTransactionUseCase } from "./application/use-cases/submit-wager-transaction.use-case";
import { WageringQueriesUseCase } from "./application/use-cases/wagering-queries.use-case";
import { OutboxPublisherWorker } from "./infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "./infrastructure/messaging/pending-reference.worker";
import { SqsClientService } from "./infrastructure/messaging/sqs-client.service";
import { WagerSqsConsumer } from "./infrastructure/messaging/wager-sqs.consumer";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { buildMikroOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { HealthController } from "./presentation/http/controllers/health.controller";
import { WageringController } from "./presentation/http/controllers/wagering.controller";
import { WalletsController } from "./presentation/http/controllers/wallets.controller";
import { GlobalDomainExceptionFilter } from "./presentation/http/filters/domain-exception.filter";
import { ProviderAuthGuard } from "./presentation/http/guards/provider-auth.guard";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        redact: ["req.headers.authorization", "req.body.money"],
        genReqId: (req) =>
          (req.headers["x-correlation-id"] as string) ?? crypto.randomUUID(),
      },
    }),
    MikroOrmModule.forRootAsync({
      useFactory: () => buildMikroOrmConfig(),
    }),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    MetricsService,
    SqsClientService,
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ReconcileWalletUseCase,
    WageringQueriesUseCase,
    WagerSqsConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    ProviderAuthGuard,
    {
      provide: ProviderIdentityPort,
      useClass: NoOpProviderIdentityAdapter,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalDomainExceptionFilter,
    },
  ],
})
export class AppModule {}
