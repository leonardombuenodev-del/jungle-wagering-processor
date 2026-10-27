import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageOrmEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageOrmEntity>({
  class: OutboxMessageOrmEntity,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id", length: 128 },
    eventType: { type: "string", fieldName: "event_type", length: 128 },
    payload: { type: "json" },
    occurredAt: { type: "Date", fieldName: "occurred_at" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { type: "Date", fieldName: "next_attempt_at", nullable: true },
    publishedAt: { type: "Date", fieldName: "published_at", nullable: true },
  },
});
