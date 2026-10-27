import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { SubmitWagerTransactionUseCase } from "../../application/use-cases/submit-wager-transaction.use-case";
import { WagerTransactionRejected } from "../../domain/events/integration-event";
import { FailureCode } from "../../domain/failure-code";
import { OutboxMessage } from "../../domain/outbox-message";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
import { MetricsService } from "../observability/metrics.service";
import { WagerTransactionOrmEntity } from "../persistence/entities/wager-transaction.orm-entity";
import { DomainPersistenceMapper } from "../persistence/mappers/domain-persistence.mapper";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  public readonly maxRetries = Number(process.env.PENDING_REF_MAX_RETRIES ?? 5);
  public readonly baseDelayMs = Number(process.env.PENDING_REF_BASE_DELAY_MS ?? 250);

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitWagerUseCase: SubmitWagerTransactionUseCase,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
      return;
    }
    this.running = true;
    this.scheduleNext(300);
  }

  onApplicationShutdown(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.processPendingBatch();
      } catch (err: unknown) {
        this.logger.error({
          msg: "Error in PendingReferenceWorker loop",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.scheduleNext(300);
      }
    }, delayMs);
  }

  async processPendingBatch(batchSize: number = 20): Promise<number> {
    return await this.em.getKnex().transaction(async (knex) => {
      const now = new Date();

      const pendingRows = await knex("wager_transactions")
        .where({ status: WagerTransactionStatus.PendingReference })
        .andWhere((qb) => {
          qb.whereNull("next_retry_at").orWhere("next_retry_at", "<=", now);
        })
        .orderBy("created_at", "asc")
        .limit(batchSize)
        .forUpdate()
        .skipLocked();

      let resolvedCount = 0;

      for (const row of pendingRows) {
        const txDomain = DomainPersistenceMapper.toTransactionDomain(this.mapRawTx(row));
        const correlationId = crypto.randomUUID();

        const refRow = await knex("wager_transactions")
          .where({
            provider_id: txDomain.providerId,
            external_transaction_id: txDomain.referenceExternalTransactionId,
          })
          .first();

        if (refRow) {
          const output = await this.submitWagerUseCase.processTransactionInsideTx(
            knex,
            txDomain,
            correlationId,
            now,
          );

          this.logger.log({
            msg: "Out-of-order PENDING_REFERENCE transaction resolved",
            transactionId: txDomain.id,
            walletId: txDomain.walletId,
            providerId: txDomain.providerId,
            newStatus: output.status,
          });
          resolvedCount += 1;
          continue;
        }

        this.metrics.retriesTotal.inc({ component: "pending_reference_worker" });

        if (txDomain.retryAttempts + 1 >= this.maxRetries) {
          txDomain.reject(FailureCode.ReferenceTransactionExpired, now);

          await knex("wager_transactions")
            .where({ id: txDomain.id })
            .update({
              status: txDomain.status,
              failure_code: txDomain.failureCode,
              retry_attempts: txDomain.retryAttempts + 1,
              processed_at: now,
            });

          const rejectedOutbox = OutboxMessage.enqueue(
            WagerTransactionRejected.from(
              txDomain,
              FailureCode.ReferenceTransactionExpired,
              {
                correlationId,
                occurredAt: now,
              },
            ),
          );

          await knex("outbox_messages").insert({
            id: rejectedOutbox.id,
            aggregate_id: rejectedOutbox.aggregateId,
            event_type: rejectedOutbox.eventType,
            payload: rejectedOutbox.payload,
            occurred_at: rejectedOutbox.occurredAt,
            attempts: rejectedOutbox.attempts,
            next_attempt_at: rejectedOutbox.nextAttemptAt ?? null,
            published_at: null,
          });

          this.metrics.transactionsTotal.inc({
            kind: txDomain.kind,
            status: txDomain.status,
            failure_code: FailureCode.ReferenceTransactionExpired,
          });

          resolvedCount += 1;
        } else {
          txDomain.schedulePendingReferenceRetry(now, this.baseDelayMs);

          await knex("wager_transactions")
            .where({ id: txDomain.id })
            .update({
              retry_attempts: txDomain.retryAttempts,
              next_retry_at: txDomain.nextRetryAt,
            });
        }
      }

      return resolvedCount;
    });
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
