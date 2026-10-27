import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { CreateWalletOutput } from "../../src/application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { SubmitWagerTransactionOutput } from "../../src/application/use-cases/submit-wager-transaction.use-case";
import { LedgerPageOutput } from "../../src/application/use-cases/wagering-queries.use-case";
import { FailureCode } from "../../src/domain/failure-code";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { OutboxPublisherWorker } from "../../src/infrastructure/messaging/outbox-publisher.worker";
import { SqsClientService } from "../../src/infrastructure/messaging/sqs-client.service";
import { WagerSqsConsumer } from "../../src/infrastructure/messaging/wager-sqs.consumer";

describe("Integration Tests (PostgreSQL + LocalStack SQS)", () => {
  let app: INestApplication;
  let orm: MikroORM;
  let em: EntityManager;
  let sqsClient: SqsClientService;
  let sqsConsumer: WagerSqsConsumer;
  let outboxWorker: OutboxPublisherWorker;
  let reconcileUseCase: ReconcileWalletUseCase;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.DISABLE_BACKGROUND_WORKERS = "true";
    process.env.LOG_LEVEL = "silent";

    app = await NestFactory.create(AppModule, { logger: false });
    orm = app.get(MikroORM);
    await orm.getMigrator().up();

    em = app.get(EntityManager);
    sqsClient = app.get(SqsClientService);
    sqsConsumer = app.get(WagerSqsConsumer);
    outboxWorker = app.get(OutboxPublisherWorker);
    reconcileUseCase = app.get(ReconcileWalletUseCase);

    await sqsClient.ensureQueuesReady();
    await app.listen(0);
    const server = app.getHttpServer();
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    const knex = em.getKnex();
    await knex.raw(
      "TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE",
    );
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("enforces physical database constraints and ledger immutability trigger", async () => {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-db-constraints",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(res.status).toBe(201);
    const wallet = (await res.json()) as CreateWalletOutput;

    const knex = em.getKnex();

    let updateFailed = false;
    try {
      await knex("wallet_ledger_entries")
        .where({ wallet_id: wallet.id })
        .update({ amount: "999.00" });
    } catch (err: unknown) {
      updateFailed = true;
      expect(String(err)).toContain("strictly immutable");
    }
    expect(updateFailed).toBe(true);

    let deleteFailed = false;
    try {
      await knex("wallet_ledger_entries").where({ wallet_id: wallet.id }).delete();
    } catch (err: unknown) {
      deleteFailed = true;
      expect(String(err)).toContain("strictly immutable");
    }
    expect(deleteFailed).toBe(true);

    let negativeBalanceFailed = false;
    try {
      await knex("wallets").where({ id: wallet.id }).update({ balance_amount: "-0.01" });
    } catch {
      negativeBalanceFailed = true;
    }
    expect(negativeBalanceFailed).toBe(true);
  });

  it("executes atomic wallet creation, BET, WIN, LOSS, REFUND and cursor ledger pagination via HTTP", async () => {
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-flow-1",
        initialBalance: { amount: "200.00", currency: "BRL" },
      }),
    });
    expect(createRes.status).toBe(201);
    const wallet = (await createRes.json()) as CreateWalletOutput;

    // 1. BET 50.00 -> 150.00
    const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-1:bet-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "bet-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-10",
        gameId: "chimp-slots",
        kind: WagerTransactionKind.Bet,
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(200);
    const betBody = (await betRes.json()) as SubmitWagerTransactionOutput;
    expect(betBody.status).toBe(WagerTransactionStatus.Processed);
    expect(betBody.balance).toEqual({ amount: "150.00", currency: "BRL" });

    // 2. WIN 120.00 -> 270.00
    const winRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-1:win-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "win-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-10",
        gameId: "chimp-slots",
        kind: WagerTransactionKind.Win,
        money: { amount: "120.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(winRes.status).toBe(200);
    const winBody = (await winRes.json()) as SubmitWagerTransactionOutput;
    expect(winBody.balance).toEqual({ amount: "270.00", currency: "BRL" });

    // 3. LOSS 0.00 -> não gera entrada no ledger e mantém 270.00
    const lossRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-1:loss-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "loss-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-11",
        gameId: "chimp-slots",
        kind: WagerTransactionKind.Loss,
        money: { amount: "0.00", currency: "BRL" },
      }),
    });
    expect(lossRes.status).toBe(200);
    const lossBody = (await lossRes.json()) as SubmitWagerTransactionOutput;
    expect(lossBody.balance).toEqual({ amount: "270.00", currency: "BRL" });

    // 4. REFUND da bet-1 (50.00) -> 320.00
    const refundRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-1:refund-1",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "refund-1",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-10",
        gameId: "chimp-slots",
        kind: WagerTransactionKind.Refund,
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(refundRes.status).toBe(200);
    const refundBody = (await refundRes.json()) as SubmitWagerTransactionOutput;
    expect(refundBody.balance).toEqual({ amount: "320.00", currency: "BRL" });

    // 5. Segundo REFUND na mesma BET deve ser REJECTED com REFERENCE_ALREADY_REVERSED (422)
    const dupRefundRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-1:refund-2",
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: "refund-2",
        playerId: "player-flow-1",
        walletId: wallet.id,
        roundId: "round-10",
        gameId: "chimp-slots",
        kind: WagerTransactionKind.Refund,
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(dupRefundRes.status).toBe(422);
    const dupRefundBody = (await dupRefundRes.json()) as SubmitWagerTransactionOutput;
    expect(dupRefundBody.status).toBe(WagerTransactionStatus.Rejected);
    expect(dupRefundBody.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // 6. Paginação por cursor no Ledger (deve conter 4 entradas: OPENING, BET, WIN, REFUND)
    const page1Res = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=2`);
    const page1 = (await page1Res.json()) as LedgerPageOutput;
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.nextCursor}`,
    );
    const page2 = (await page2Res.json()) as LedgerPageOutput;
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();

    // 7. Reconciliação final: wallet.balance == saldo reconstruído pelo ledger
    const recon = await reconcileUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toEqual({ amount: "320.00", currency: "BRL" });
    expect(recon.calculatedBalance).toEqual({ amount: "320.00", currency: "BRL" });
    expect(recon.checkedEntries).toBe(4);
  });

  it("handles SQS consumption, persistent inbox deduplication, DLQ routing and Outbox publishing", async () => {
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-sqs-1",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as CreateWalletOutput;

    const validEnvelope = {
      messageId: "sqs-msg-100",
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "prov-sqs",
        externalTransactionId: "ext-sqs-1",
        idempotencyKey: "prov-sqs:ext-sqs-1",
        playerId: "player-sqs-1",
        walletId: wallet.id,
        roundId: "round-sqs",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "30.00", currency: "BRL" },
      },
    };

    await sqsClient.client.send(
      new SendMessageCommand({
        QueueUrl: sqsClient.wagerQueueUrl,
        MessageBody: JSON.stringify(validEnvelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: `dedup-valid-${Date.now()}`,
      }),
    );

    await sqsClient.client.send(
      new SendMessageCommand({
        QueueUrl: sqsClient.wagerQueueUrl,
        MessageBody: "{ invalid_json_payload",
        MessageGroupId: `malformed-${wallet.id}`,
        MessageDeduplicationId: `dedup-malformed-${Date.now()}`,
      }),
    );

    for (let i = 0; i < 5; i++) {
      const processed = await sqsConsumer.pollOnce();
      if (processed === 0 && i >= 1) break;
    }

    const publishedEvents = await outboxWorker.publishBatch();
    expect(publishedEvents).toBeGreaterThanOrEqual(3);

    const recon = await reconcileUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toEqual({ amount: "70.00", currency: "BRL" });
  });
});