import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageOrmEntity {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageOrmEntity>({
  class: InboxMessageOrmEntity,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", fieldName: "consumer_name", primary: true, length: 128 },
    messageId: { type: "string", fieldName: "message_id", primary: true, length: 128 },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    receivedAt: { type: "Date", fieldName: "received_at", onCreate: () => new Date() },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});
