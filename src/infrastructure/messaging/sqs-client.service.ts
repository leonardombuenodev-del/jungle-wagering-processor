import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

@Injectable()
export class SqsClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsClientService.name);
  public readonly client: SQSClient;

  public wagerQueueUrl!: string;
  public wagerDlqUrl!: string;
  public eventsQueueUrl!: string;

  public readonly wagerQueueName =
    process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo";
  public readonly wagerDlqName =
    process.env.SQS_WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo";
  public readonly eventsQueueName =
    process.env.SQS_EVENTS_QUEUE_NAME ?? "wagering-events.fifo";

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.SKIP_SQS_INIT === "true") {
      return;
    }
    await this.ensureQueuesReady();
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async ensureQueuesReady(): Promise<void> {
    try {
      this.wagerDlqUrl = await this.getOrCreateFifoQueue(this.wagerDlqName);

      const dlqAttrs = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerDlqUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      const dlqArn = dlqAttrs.Attributes?.QueueArn;

      this.wagerQueueUrl = await this.getOrCreateFifoQueue(
        this.wagerQueueName,
        dlqArn
          ? {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: dlqArn,
                maxReceiveCount: "5",
              }),
            }
          : undefined,
      );

      this.eventsQueueUrl = await this.getOrCreateFifoQueue(this.eventsQueueName);
    } catch (err: unknown) {
      this.logger.warn({
        msg: "SQS queues not reachable yet during startup; will retry on demand",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async getOrCreateFifoQueue(
    queueName: string,
    extraAttributes?: Record<string, string>,
  ): Promise<string> {
    try {
      const existing = await this.client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      if (existing.QueueUrl) {
        return existing.QueueUrl;
      }
    } catch {
      // Fila não existe ainda, criamos abaixo
    }

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
          ...(extraAttributes ?? {}),
        },
      }),
    );

    return created.QueueUrl!;
  }

  async checkHealth(): Promise<boolean> {
    try {
      if (!this.wagerQueueUrl) {
        await this.ensureQueuesReady();
      }
      if (!this.wagerQueueUrl) return false;

      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async receiveWagerMessages(maxMessages: number = 5, waitTimeSeconds: number = 1): Promise<Message[]> {
    if (!this.wagerQueueUrl) {
      await this.ensureQueuesReady();
      if (!this.wagerQueueUrl) return [];
    }

    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );

    return response.Messages ?? [];
  }

  async ackWagerMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async releaseMessageVisibility(receiptHandle: string, visibilityTimeoutSeconds: number = 0): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async sendToDlq(body: string, messageGroupId: string, deduplicationId: string): Promise<void> {
    if (!this.wagerDlqUrl) {
      await this.ensureQueuesReady();
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.wagerDlqUrl,
        MessageBody: body,
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async publishIntegrationEvent(
    eventId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.eventsQueueUrl) {
      await this.ensureQueuesReady();
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }
}
