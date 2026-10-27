import { Message } from "@aws-sdk/client-sqs";
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { SubmitWagerTransactionUseCase } from "../../application/use-cases/submit-wager-transaction.use-case";
import { DomainError } from "../../domain/errors/domain.errors";
import { WagerTransactionKind } from "../../domain/wager-transaction";
import { MetricsService } from "../observability/metrics.service";
import { SqsClientService } from "./sqs-client.service";

export interface WagerSqsMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  correlationId?: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: {
      amount: string;
      currency: string;
    };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class WagerSqsConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WagerSqsConsumer.name);
  public readonly consumerName = "wager-transactions-sqs-consumer";
  public readonly maxReceiveAttempts = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);

  private running = false;
  private shuttingDown = false;
  private activeProcessingPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(SqsClientService) private readonly sqsClient: SqsClientService,
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitWagerUseCase: SubmitWagerTransactionUseCase,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === "true") {
      return;
    }
    this.startPolling();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log({ msg: "Graceful shutdown initiated on SQS consumer", signal });
    this.shuttingDown = true;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.activeProcessingPromise) {
      await this.activeProcessingPromise;
    }
  }

  startPolling(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll(100);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running || this.shuttingDown) return;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err: unknown) {
        this.logger.error({
          msg: "Unexpected error in SQS polling loop",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.scheduleNextPoll(200);
      }
    }, delayMs);
  }

  async pollOnce(): Promise<number> {
    if (this.shuttingDown) return 0;

    const messages = await this.sqsClient.receiveWagerMessages(5, 0);
    let processedCount = 0;

    for (const msg of messages) {
      if (this.shuttingDown) {
        if (msg.ReceiptHandle) {
          await this.sqsClient.releaseMessageVisibility(msg.ReceiptHandle, 0);
        }
        break;
      }

      this.activeProcessingPromise = this.handleSingleMessage(msg);
      await this.activeProcessingPromise;
      this.activeProcessingPromise = null;
      processedCount += 1;
    }

    return processedCount;
  }

  async handleSingleMessage(
    msg: Message,
    options?: { simulateCrashBeforeAck?: boolean },
  ): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const rawBody = msg.Body ?? "";
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");

    let envelope: WagerSqsMessageEnvelope;

    try {
      envelope = JSON.parse(rawBody) as WagerSqsMessageEnvelope;
      if (
        !envelope ||
        !envelope.messageId ||
        envelope.type !== "WagerTransactionRequested" ||
        !envelope.data
      ) {
        throw new Error("Invalid WagerTransactionRequested message envelope");
      }
    } catch (parseErr: unknown) {
      this.logger.error({
        msg: "Permanent malformed SQS message; routing to DLQ",
        sqsMessageId: msg.MessageId,
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      await this.sqsClient.sendToDlq(
        rawBody || "{}",
        "malformed-group",
        msg.MessageId ?? crypto.randomUUID(),
      );
      this.metrics.dlqMessagesTotal.inc({ reason: "malformed_payload" });
      if (receiptHandle) {
        await this.sqsClient.ackWagerMessage(receiptHandle);
      }
      return;
    }

    const { data } = envelope;
    const idempotencyKey =
      data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`;
    const correlationId = envelope.correlationId ?? envelope.messageId;

    try {
      const output = await this.submitWagerUseCase.execute({
        idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId,
        inboxContext: {
          consumerName: this.consumerName,
          messageId: envelope.messageId,
        },
      });

      this.logger.log({
        msg: "SQS wager message processed",
        correlationId,
        messageId: envelope.messageId,
        transactionId: output.transactionId,
        walletId: data.walletId,
        providerId: data.providerId,
        status: output.status,
        idempotentReplay: output.idempotentReplay,
      });

      if (options?.simulateCrashBeforeAck) {
        throw new Error("SIMULATED_CRASH_AFTER_COMMIT_BEFORE_ACK");
      }

      if (receiptHandle) {
        await this.sqsClient.ackWagerMessage(receiptHandle);
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message === "SIMULATED_CRASH_AFTER_COMMIT_BEFORE_ACK"
      ) {
        throw err;
      }

      if (err instanceof DomainError) {
        this.logger.warn({
          msg: "Permanent domain error on SQS message; routing to DLQ and ACKing",
          correlationId,
          messageId: envelope.messageId,
          walletId: data.walletId,
          providerId: data.providerId,
          errorCode: err.code,
        });

        await this.sqsClient.sendToDlq(
          rawBody,
          data.walletId || "domain-error",
          envelope.messageId,
        );
        this.metrics.dlqMessagesTotal.inc({ reason: err.code });

        if (receiptHandle) {
          await this.sqsClient.ackWagerMessage(receiptHandle);
        }
        return;
      }

      this.metrics.retriesTotal.inc({ component: "sqs_consumer" });

      if (receiveCount >= this.maxReceiveAttempts) {
        this.logger.error({
          msg: "Max receive attempts exhausted for SQS message; routing to DLQ",
          correlationId,
          messageId: envelope.messageId,
          walletId: data.walletId,
          providerId: data.providerId,
          receiveCount,
        });

        await this.sqsClient.sendToDlq(
          rawBody,
          data.walletId || "max-retries",
          envelope.messageId,
        );
        this.metrics.dlqMessagesTotal.inc({ reason: "max_retries_exhausted" });

        if (receiptHandle) {
          await this.sqsClient.ackWagerMessage(receiptHandle);
        }
        return;
      }

      const backoffSeconds = Math.min(Math.pow(2, receiveCount), 30);
      if (receiptHandle) {
        await this.sqsClient.releaseMessageVisibility(receiptHandle, backoffSeconds);
      }
    }
  }
}
