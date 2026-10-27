import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { MetricsService } from "../observability/metrics.service";
import { OutboxMessageOrmEntity } from "../persistence/entities/outbox-message.orm-entity";
import { DomainPersistenceMapper } from "../persistence/mappers/domain-persistence.mapper";
import { SqsClientService } from "./sqs-client.service";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsClientService) private readonly sqsClient: SqsClientService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
      return;
    }
    this.running = true;
    this.scheduleNext(250);
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
        await this.publishBatch();
      } catch (err: unknown) {
        this.logger.error({
          msg: "Error in OutboxPublisherWorker loop",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.scheduleNext(250);
      }
    }, delayMs);
  }

  async publishBatch(batchSize: number = 25): Promise<number> {
    return await this.em.getKnex().transaction(async (knex) => {
      const now = new Date();

      const rows = await knex("outbox_messages")
        .whereNull("published_at")
        .andWhere((qb) => {
          qb.whereNull("next_attempt_at").orWhere("next_attempt_at", "<=", now);
        })
        .orderBy("occurred_at", "asc")
        .limit(batchSize)
        .forUpdate()
        .skipLocked();

      let count = 0;

      for (const row of rows) {
        const outbox = DomainPersistenceMapper.toOutboxDomain(this.mapRawOutbox(row));

        try {
          await this.sqsClient.publishIntegrationEvent(
            outbox.id,
            outbox.aggregateId,
            outbox.payload as Record<string, unknown>,
          );

          outbox.markPublished(now);
          await knex("outbox_messages")
            .where({ id: outbox.id })
            .update({
              published_at: outbox.publishedAt,
            });

          count += 1;
        } catch (err: unknown) {
          outbox.scheduleRetry(now, 1000);
          this.metrics.retriesTotal.inc({ component: "outbox_publisher" });

          await knex("outbox_messages")
            .where({ id: outbox.id })
            .update({
              attempts: outbox.attempts,
              next_attempt_at: outbox.nextAttemptAt,
            });

          this.logger.warn({
            msg: "Failed to publish outbox event; scheduled retry with backoff",
            eventId: outbox.id,
            eventType: outbox.eventType,
            aggregateId: outbox.aggregateId,
            attempts: outbox.attempts,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const oldestPending = await knex("outbox_messages")
        .whereNull("published_at")
        .orderBy("occurred_at", "asc")
        .first();

      if (oldestPending && oldestPending.occurred_at) {
        const ageSeconds = Math.max(
          0,
          (now.getTime() - new Date(String(oldestPending.occurred_at)).getTime()) / 1000,
        );
        this.metrics.outboxLagSeconds.set(ageSeconds);
      } else {
        this.metrics.outboxLagSeconds.set(0);
      }

      return count;
    });
  }

  private mapRawOutbox(row: Record<string, unknown>): OutboxMessageOrmEntity {
    const orm = new OutboxMessageOrmEntity();
    orm.id = String(row.id);
    orm.aggregateId = String(row.aggregate_id);
    orm.eventType = String(row.event_type);
    orm.payload =
      typeof row.payload === "string"
        ? JSON.parse(row.payload)
        : (row.payload as Record<string, unknown>);
    orm.occurredAt = new Date(String(row.occurred_at));
    orm.attempts = Number(row.attempts ?? 0);
    orm.nextAttemptAt = row.next_attempt_at ? new Date(String(row.next_attempt_at)) : null;
    orm.publishedAt = row.published_at ? new Date(String(row.published_at)) : null;
    return orm;
  }
}
