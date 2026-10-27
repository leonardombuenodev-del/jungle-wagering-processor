import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import {
  ReconcileWalletOutput,
  ReconcileWalletUseCase,
} from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  SubmitWagerTransactionOutput,
  SubmitWagerTransactionUseCase,
} from "../../src/application/use-cases/submit-wager-transaction.use-case";
import { FailureCode } from "../../src/domain/failure-code";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { OutboxPublisherWorker } from "../../src/infrastructure/messaging/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/messaging/pending-reference.worker";
import { SqsClientService } from "../../src/infrastructure/messaging/sqs-client.service";
import { WagerSqsConsumer } from "../../src/infrastructure/messaging/wager-sqs.consumer";

describe("Mandatory Concurrency & Fault-Tolerance Scenarios (Section 8 & 13)", () => {
  let app1: INestApplication;
  let app2: INestApplication;
  let app3: INestApplication;
  let url1: string;
  let url2: string;
  let url3: string;

  let orm: MikroORM;
  let em: EntityManager;
  let createWallet: CreateWalletUseCase;
  let submitWager: SubmitWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;
  let sqsConsumer: WagerSqsConsumer;
  let outboxWorker1: OutboxPublisherWorker;
  let outboxWorker2: OutboxPublisherWorker;
  let pendingRefWorker: PendingReferenceWorker;

  beforeAll(async () => {
    process.env.DISABLE_BACKGROUND_WORKERS = "true";
    process.env.LOG_LEVEL = "silent";

    app1 = await NestFactory.create(AppModule, { logger: false });
    orm = app1.get(MikroORM);
    await orm.getMigrator().up();
    await app1.get(SqsClientService).ensureQueuesReady();

    app2 = await NestFactory.create(AppModule, { logger: false });
    app3 = await NestFactory.create(AppModule, { logger: false });

    await app1.listen(0);
    await app2.listen(0);
    await app3.listen(0);

    url1 = `http://127.0.0.1:${app1.getHttpServer().address().port}`;
    url2 = `http://127.0.0.1:${app2.getHttpServer().address().port}`;
    url3 = `http://127.0.0.1:${app3.getHttpServer().address().port}`;

    em = app1.get(EntityManager);
    createWallet = app1.get(CreateWalletUseCase);
    submitWager = app1.get(SubmitWagerTransactionUseCase);
    reconcileWallet = app1.get(ReconcileWalletUseCase);
    sqsConsumer = app1.get(WagerSqsConsumer);
    outboxWorker1 = app1.get(OutboxPublisherWorker);
    outboxWorker2 = app2.get(OutboxPublisherWorker);
    pendingRefWorker = app1.get(PendingReferenceWorker);
  });

  beforeEach(async () => {
    const knex = em.getKnex();
    await knex.raw(
      "TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE",
    );
  });

  afterAll(async () => {
    await Promise.all([app1?.close(), app2?.close(), app3?.close()]);
  });

  // CENÁRIO 1: A mesma aposta enviada 50 vezes em paralelo -> um único débito
  it("1. processes the exact same bet 50 times in parallel producing a single debit", async () => {
    const wallet = await createWallet.execute({
      playerId: "player-50-parallel",
      initialBalance: { amount: "500.00", currency: "BRL" },
    });

    const urls = [url1, url2, url3];
    const requests = Array.from({ length: 50 }, (_, idx) => {
      const targetUrl = urls[idx % urls.length]!;
      return fetch(`${targetUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "provider-x:same-bet-50",
        },
        body: JSON.stringify({
          providerId: "provider-x",
          externalTransactionId: "same-bet-50",
          playerId: "player-50-parallel",
          walletId: wallet.id,
          roundId: "round-50",
          gameId: "fortune-chimp",
          kind: WagerTransactionKind.Bet,
          money: { amount: "25.00", currency: "BRL" },
        }),
      }).then((r) => r.json() as Promise<SubmitWagerTransactionOutput>);
    });

    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance).toEqual({ amount: "475.00", currency: "BRL" });
    }

    const firstProcesses = responses.filter((r) => r.idempotentReplay === false);
    const replays = responses.filter((r) => r.idempotentReplay === true);
    expect(firstProcesses.length).toBe(1);
    expect(replays.length).toBe(49);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toEqual({ amount: "475.00", currency: "BRL" });
    expect(recon.checkedEntries).toBe(2); // 1 OPENING + 1 BET
  });

  // CENÁRIO 2 (Obrigatório da Seção 8): Saldo 100.00 BRL, duas apostas de 80.00 BRL simultâneas
  it("2. enforces hot-wallet concurrency: 100.00 BRL balance vs two simultaneous 80.00 BRL bets", async () => {
    const wallet = await createWallet.execute({
      playerId: "player-hot-wallet",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const [resA, resB] = await Promise.all([
      fetch(`${url1}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "prov-hot:bet-80-a",
        },
        body: JSON.stringify({
          providerId: "prov-hot",
          externalTransactionId: "bet-80-a",
          playerId: "player-hot-wallet",
          walletId: wallet.id,
          roundId: "round-hot",
          gameId: "fortune-chimp",
          kind: WagerTransactionKind.Bet,
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({
        httpStatus: r.status,
        body: (await r.json()) as SubmitWagerTransactionOutput,
      })),
      fetch(`${url2}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "prov-hot:bet-80-b",
        },
        body: JSON.stringify({
          providerId: "prov-hot",
          externalTransactionId: "bet-80-b",
          playerId: "player-hot-wallet",
          walletId: wallet.id,
          roundId: "round-hot",
          gameId: "fortune-chimp",
          kind: WagerTransactionKind.Bet,
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({
        httpStatus: r.status,
        body: (await r.json()) as SubmitWagerTransactionOutput,
      })),
    ]);

    const results = [resA, resB];
    const processed = results.filter((r) => r.body.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.body.status === WagerTransactionStatus.Rejected);

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(processed[0]!.httpStatus).toBe(200);
    expect(rejected[0]!.httpStatus).toBe(422);
    expect(rejected[0]!.body.failureCode).toBe(FailureCode.InsufficientFunds);

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toEqual({ amount: "20.00", currency: "BRL" });
    expect(recon.checkedEntries).toBe(2); // 1 OPENING + 1 DEBIT
  });

  // CENÁRIO 3 & 4: Wallets distintas em paralelo distribuídas entre >= 3 instâncias simultâneas
  it("3 & 4. processes distinct wallets in parallel across 3 simultaneous instances without lost updates", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createWallet.execute({
          playerId: `player-multi-${i}`,
          initialBalance: { amount: "100.00", currency: "BRL" },
        }),
      ),
    );

    const urls = [url1, url2, url3];
    const operations: Array<Promise<unknown>> = [];

    for (const [wIdx, w] of wallets.entries()) {
      for (let b = 1; b <= 5; b++) {
        const instanceUrl = urls[(wIdx + b) % urls.length]!;
        operations.push(
          fetch(`${instanceUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `prov-m:w-${wIdx}-bet-${b}`,
            },
            body: JSON.stringify({
              providerId: "prov-m",
              externalTransactionId: `w-${wIdx}-bet-${b}`,
              playerId: w.playerId,
              walletId: w.id,
              roundId: `round-${b}`,
              gameId: "fortune-chimp",
              kind: WagerTransactionKind.Bet,
              money: { amount: "10.00", currency: "BRL" },
            }),
          }),
        );
      }
    }

    await Promise.all(operations);

    for (const w of wallets) {
      const recon = await reconcileWallet.execute(w.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance).toEqual({ amount: "50.00", currency: "BRL" });
      expect(recon.checkedEntries).toBe(6); // 1 OPENING + 5 BETs
    }
  });

  // CENÁRIO 5: Worker morto depois do commit e antes do ack -> redelivery não duplica débito
  it("5. recovers safely when worker crashes after SQL commit and before SQS ack", async () => {
    const wallet = await createWallet.execute({
      playerId: "player-crash-ack",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const sqsMsg = {
      MessageId: "aws-msg-crash-1",
      ReceiptHandle: "dummy-receipt",
      Body: JSON.stringify({
        messageId: "inbox-msg-crash-1",
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "prov-crash",
          externalTransactionId: "tx-crash-1",
          idempotencyKey: "prov-crash:tx-crash-1",
          playerId: "player-crash-ack",
          walletId: wallet.id,
          roundId: "round-crash",
          gameId: "fortune-chimp",
          kind: WagerTransactionKind.Bet,
          money: { amount: "40.00", currency: "BRL" },
        },
      }),
    };

    await expect(
      sqsConsumer.handleSingleMessage(sqsMsg, { simulateCrashBeforeAck: true }),
    ).rejects.toThrow("SIMULATED_CRASH_AFTER_COMMIT_BEFORE_ACK");

    await sqsConsumer.handleSingleMessage({
      ...sqsMsg,
      ReceiptHandle: undefined,
    });

    const recon = await reconcileWallet.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toEqual({ amount: "60.00", currency: "BRL" });
    expect(recon.checkedEntries).toBe(2); // 1 OPENING + 1 BET
  });

  // CENÁRIO 6: Dois publishers concorrentes sobre a mesma Outbox (SKIP LOCKED)
  it("6. runs two concurrent Outbox publishers over the same outbox table without conflict", async () => {
    const wallet = await createWallet.execute({
      playerId: "player-outbox-race",
      initialBalance: { amount: "200.00", currency: "BRL" },
    });

    for (let i = 1; i <= 10; i++) {
      await submitWager.execute({
        idempotencyKey: `prov-ob:bet-${i}`,
        providerId: "prov-ob",
        externalTransactionId: `bet-${i}`,
        playerId: "player-outbox-race",
        walletId: wallet.id,
        roundId: `round-${i}`,
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "10.00", currency: "BRL" },
      });
    }

    const [pub1, pub2] = await Promise.all([
      outboxWorker1.publishBatch(15),
      outboxWorker2.publishBatch(15),
    ]);

    expect(pub1 + pub2).toBe(22);

    const remaining = await em
      .getKnex()("outbox_messages")
      .whereNull("published_at")
      .count("* as cnt")
      .first();
    expect(Number(remaining?.cnt)).toBe(0);
  });

  // CENÁRIO 7 & 8: ROLLBACK entregue antes da referência + reinício e consistência final
  it("7 & 8. resolves out-of-order ROLLBACK delivered before BET and preserves ledger invariant across restart", async () => {
    const wallet = await createWallet.execute({
      playerId: "player-out-of-order",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const rollbackRes = await fetch(`${url1}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-ooo:rollback-early",
      },
      body: JSON.stringify({
        providerId: "prov-ooo",
        externalTransactionId: "rollback-early",
        playerId: "player-out-of-order",
        walletId: wallet.id,
        roundId: "round-ooo-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Rollback,
        money: { amount: "30.00", currency: "BRL" },
        referenceExternalTransactionId: "bet-late",
      }),
    });
    expect(rollbackRes.status).toBe(202);
    const rollbackEarlyBody = (await rollbackRes.json()) as SubmitWagerTransactionOutput;
    expect(rollbackEarlyBody.status).toBe(WagerTransactionStatus.PendingReference);

    const lateBetRes = await fetch(`${url2}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "prov-ooo:bet-late",
      },
      body: JSON.stringify({
        providerId: "prov-ooo",
        externalTransactionId: "bet-late",
        playerId: "player-out-of-order",
        walletId: wallet.id,
        roundId: "round-ooo-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      }),
    });
    expect(lateBetRes.status).toBe(200);
    const lateBetBody = (await lateBetRes.json()) as SubmitWagerTransactionOutput;
    expect(lateBetBody.balance).toEqual({ amount: "70.00", currency: "BRL" });

    await em
      .getKnex()("wager_transactions")
      .where({ id: rollbackEarlyBody.transactionId })
      .update({ next_retry_at: new Date(Date.now() - 1000) });

    const resolved = await pendingRefWorker.processPendingBatch();
    expect(resolved).toBe(1);

    await app3.close();
    app3 = await NestFactory.create(AppModule, { logger: false });
    await app3.listen(0);
    url3 = `http://127.0.0.1:${app3.getHttpServer().address().port}`;

    const reconRes = await fetch(`${url3}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    const reconBody = (await reconRes.json()) as ReconcileWalletOutput;

    expect(reconBody.consistent).toBe(true);
    expect(reconBody.storedBalance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(reconBody.calculatedBalance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(reconBody.checkedEntries).toBe(3);
  });
});