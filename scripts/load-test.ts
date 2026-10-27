import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { CreateWalletOutput } from "../src/application/use-cases/create-wallet.use-case";
import { ReconcileWalletOutput } from "../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionKind } from "../src/domain/wager-transaction";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function runLoadTest() {
  process.env.LOG_LEVEL = "silent";
  process.env.DISABLE_BACKGROUND_WORKERS = "true";

  const app = await NestFactory.create(AppModule, { logger: false });
  const orm = app.get(MikroORM);
  await orm.getMigrator().up();
  await app.listen(0);

  const port = app.getHttpServer().address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`🚀 Starting Load Test against Distributed Wagering Processor at ${baseUrl}...`);

  const walletCount = 10;
  const requestsPerWallet = 30;
  const totalRequests = walletCount * requestsPerWallet;

  const wallets = await Promise.all(
    Array.from({ length: walletCount }, (_, i) =>
      fetch(`${baseUrl}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: `load-player-${i}-${Date.now()}`,
          initialBalance: { amount: "1000.00", currency: "BRL" },
        }),
      }).then((r) => r.json() as Promise<CreateWalletOutput>),
    ),
  );

  const latencies: number[] = [];
  let successCount = 0;
  let errorCount = 0;

  const startTime = performance.now();

  const tasks: Array<Promise<void>> = [];
  for (const w of wallets) {
    for (let r = 1; r <= requestsPerWallet; r++) {
      tasks.push(
        (async () => {
          const t0 = performance.now();
          const res = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": `load:${w.id}:tx-${r}`,
            },
            body: JSON.stringify({
              providerId: "load-provider",
              externalTransactionId: `${w.id}-tx-${r}`,
              playerId: w.playerId,
              walletId: w.id,
              roundId: `round-${r}`,
              gameId: "fortune-chimp",
              kind: r % 3 === 0 ? WagerTransactionKind.Win : WagerTransactionKind.Bet,
              money: { amount: "10.00", currency: "BRL" },
            }),
          });
          latencies.push(performance.now() - t0);
          if (res.status === 200) {
            successCount += 1;
          } else {
            errorCount += 1;
          }
        })(),
      );
    }
  }

  await Promise.all(tasks);
  const totalTimeSec = (performance.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);

  let allConsistent = true;
  for (const w of wallets) {
    const recon = (await fetch(`${baseUrl}/wallets/${w.id}/reconciliation`, {
      method: "POST",
    }).then((r) => r.json())) as ReconcileWalletOutput;
    if (!recon.consistent) {
      allConsistent = false;
    }
  }

  const metricsText = await fetch(`${baseUrl}/metrics`).then((r) => r.text());
  const lockConflictsMatch = metricsText.match(/wagering_lock_conflicts_total\{[^}]*\}\s+(\d+)/);
  const outboxLagMatch = metricsText.match(/wagering_outbox_lag_seconds\s+([0-9.]+)/);
  const lockConflicts = lockConflictsMatch ? lockConflictsMatch[1] : "0";
  const outboxLag = outboxLagMatch ? Number(outboxLagMatch[1]).toFixed(3) : "0.000";

  console.log("\n📊 === LOAD TEST RESULTS ===");
  console.log(`Total Requests     : ${totalRequests}`);
  console.log(`Concurrency        : ${walletCount} active hot wallets`);
  console.log(`Total Duration     : ${totalTimeSec.toFixed(2)}s`);
  console.log(`Throughput (RPS)   : ${(totalRequests / totalTimeSec).toFixed(2)} req/s`);
  console.log(`Latency p50        : ${percentile(latencies, 50).toFixed(2)} ms`);
  console.log(`Latency p95        : ${percentile(latencies, 95).toFixed(2)} ms`);
  console.log(`Latency p99        : ${percentile(latencies, 99).toFixed(2)} ms`);
  console.log(`Success / Errors   : ${successCount} / ${errorCount}`);
  console.log(`Lock Conflicts     : ${lockConflicts} (serialized via row-level FOR UPDATE)`);
  console.log(`Outbox Lag         : ${outboxLag}s`);
  console.log(`Ledger Invariant   : ${allConsistent ? "✅ 100% CONSISTENT" : "❌ DIVERGENCE"}`);

  await app.close();
  process.exit(0);
}

runLoadTest();